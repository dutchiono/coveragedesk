import os
import re
import shlex
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
ALLOWED_CHAT_IDS = {
  value.strip()
  for value in os.getenv("TELEGRAM_ALLOWED_CHAT_IDS", "").split(",")
  if value.strip()
}
REPO_DIR = Path(os.getenv("MARKBETS_REPO_DIR", Path(__file__).resolve().parents[1]))
OPENCODE_BIN = os.getenv("OPENCODE_BIN", "opencode")
OPENCODE_MODEL = os.getenv("OPENCODE_MODEL", "")
OPENCODE_AGENT = os.getenv("OPENCODE_AGENT", "telegram-small-adjuster")
GIT_REMOTE = os.getenv("TELEGRAM_GIT_REMOTE", "origin")
MAX_CHANGED_FILES = int(os.getenv("TELEGRAM_MAX_CHANGED_FILES", "8"))
MAX_CHANGED_LINES = int(os.getenv("TELEGRAM_MAX_CHANGED_LINES", "450"))


def run(command: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
  return subprocess.run(
    command,
    cwd=REPO_DIR,
    env=os.environ.copy(),
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    timeout=timeout,
  )


def safe_branch_name(text: str) -> str:
  slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:42] or "request"
  return f"telegram/{int(time.time())}-{slug}"


def changed_size() -> tuple[int, int]:
  result = run(["git", "diff", "--numstat"], timeout=30)
  files = 0
  lines = 0
  for raw in result.stdout.splitlines():
    parts = raw.split("\t")
    if len(parts) < 3:
      continue
    files += 1
    for value in parts[:2]:
      if value.isdigit():
        lines += int(value)
  return files, lines


def validate() -> str:
  checks = [
    (["npm", "run", "build"], 180),
    (["python", "-m", "py_compile", "backend/main.py", "backend/telegram_agent.py"], 60),
  ]
  output: list[str] = []
  for command, timeout in checks:
    result = run(command, timeout=timeout)
    output.append(f"$ {' '.join(command)}\n{result.stdout[-1800:]}")
    if result.returncode != 0:
      raise RuntimeError("\n\n".join(output))
  return "\n\n".join(output)


def opencode_prompt(user_text: str) -> str:
  return f"""
You are editing the MarkBets repo from a Telegram request.

Request:
{user_text}

Keep the change small. Do not touch secrets, env files, deployment credentials, trading/order code, nginx, or certbot.
After editing, leave the repo ready for npm run build and backend py_compile.
"""


def make_adjustment(user_text: str) -> str:
  run(["git", "fetch", GIT_REMOTE, "main"], timeout=90)
  branch = safe_branch_name(user_text)
  checkout = run(["git", "checkout", "-B", branch, f"{GIT_REMOTE}/main"], timeout=60)
  if checkout.returncode != 0:
    raise RuntimeError(checkout.stdout)

  command = [
    OPENCODE_BIN,
    "run",
    "--agent",
    OPENCODE_AGENT,
    "--dir",
    str(REPO_DIR),
    "--auto",
  ]
  if OPENCODE_MODEL:
    command.extend(["--model", OPENCODE_MODEL])
  command.append(opencode_prompt(user_text))

  agent = run(command, timeout=900)
  if agent.returncode != 0:
    raise RuntimeError(agent.stdout[-3500:])

  files, lines = changed_size()
  if files == 0:
    return f"No code changes were made.\n\n{agent.stdout[-1200:]}"
  if files > MAX_CHANGED_FILES or lines > MAX_CHANGED_LINES:
    run(["git", "reset", "--hard", f"{GIT_REMOTE}/main"], timeout=60)
    return f"Rejected as too large for Telegram: {files} files and {lines} changed lines."

  validation = validate()
  run(["git", "add", "."], timeout=60)
  commit_message = f"Telegram adjustment: {user_text[:64]}".strip()
  commit = run(["git", "commit", "-m", commit_message], timeout=90)
  if commit.returncode != 0:
    raise RuntimeError(commit.stdout)
  push = run(["git", "push", "-u", GIT_REMOTE, branch], timeout=180)
  if push.returncode != 0:
    raise RuntimeError(push.stdout)

  pr_url = create_pr(branch, commit_message)
  target = pr_url or f"branch `{branch}`"
  return f"Created {target}\n\nChanged {files} files / {lines} lines.\n\nValidation passed."


def create_pr(branch: str, title: str) -> str | None:
  body = "Created from an authorized Telegram request. Review before merging."
  result = run(
    ["gh", "pr", "create", "--title", title, "--body", body, "--base", "main", "--head", branch],
    timeout=120,
  )
  if result.returncode != 0:
    return None
  match = re.search(r"https://\S+", result.stdout)
  return match.group(0) if match else None


async def telegram(method: str, payload: dict[str, Any]) -> dict[str, Any]:
  async with httpx.AsyncClient(timeout=60) as client:
    response = await client.post(f"https://api.telegram.org/bot{BOT_TOKEN}/{method}", json=payload)
    response.raise_for_status()
    return response.json()


async def reply(chat_id: int | str, text: str) -> None:
  await telegram("sendMessage", {"chat_id": chat_id, "text": text[:3900]})


def command_payload(text: str, command: str) -> str | None:
  pattern = rf"^/{re.escape(command)}(?:@\w+)?(?:\s+(.*))?$"
  match = re.match(pattern, text, re.S)
  if not match:
    return None
  return (match.group(1) or "").strip()


async def main() -> None:
  if not BOT_TOKEN:
    raise RuntimeError("TELEGRAM_BOT_TOKEN is required")
  if not ALLOWED_CHAT_IDS:
    raise RuntimeError("TELEGRAM_ALLOWED_CHAT_IDS is required")

  offset = 0
  while True:
    async with httpx.AsyncClient(timeout=70) as client:
      response = await client.get(
        f"https://api.telegram.org/bot{BOT_TOKEN}/getUpdates",
        params={"timeout": 50, "offset": offset},
      )
      response.raise_for_status()
      updates = response.json().get("result", [])

    for update in updates:
      offset = max(offset, update["update_id"] + 1)
      message = update.get("message") or {}
      chat = message.get("chat") or {}
      chat_id = str(chat.get("id", ""))
      text = (message.get("text") or "").strip()
      if not chat_id or not text:
        continue
      if chat_id not in ALLOWED_CHAT_IDS:
        await reply(chat_id, "Not authorized.")
        continue
      if command_payload(text, "id") is not None:
        await reply(chat_id, f"chat id: {chat_id}")
        continue
      request = command_payload(text, "adjust")
      if request is None:
        await reply(chat_id, "Send /adjust followed by the small repo change you want.")
        continue
      if not request:
        await reply(chat_id, "Send /adjust followed by the small repo change you want.")
        continue

      await reply(chat_id, "Got it. Running the small-adjustment agent.")
      try:
        result = make_adjustment(request)
      except Exception as exc:
        result = f"Adjustment failed:\n{exc}"
      await reply(chat_id, result)


if __name__ == "__main__":
  import asyncio

  asyncio.run(main())
