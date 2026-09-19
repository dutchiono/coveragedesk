import asyncio
import os
import sys
from typing import Any

import httpx

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
BOT_USERNAME = os.getenv("TELEGRAM_BOT_USERNAME", "coveragedesk_bot").strip().lower().lstrip("@")
API_BASE_URL = os.getenv("COVERAGEDESK_API", "http://127.0.0.1:8800").rstrip("/")
TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"
ALLOWED_CHAT_IDS = {
    value.strip()
    for value in os.getenv("TELEGRAM_ALLOWED_CHAT_IDS", "").split(",")
    if value.strip()
}


def is_allowed_chat(chat_id: int | str) -> bool:
    return not ALLOWED_CHAT_IDS or str(chat_id) in ALLOWED_CHAT_IDS


def should_answer(message: dict[str, Any], text: str) -> bool:
    chat = message.get("chat") or {}
    if chat.get("type") == "private":
        return True
    lowered = text.lower()
    return lowered.startswith("/") or f"@{BOT_USERNAME}" in lowered


def clean_user_text(text: str) -> str:
    cleaned = text.replace(f"@{BOT_USERNAME}", "").replace(f"@{BOT_USERNAME.upper()}", "")
    return cleaned.strip() or "What is the current LineEdge read?"


async def telegram(method: str, payload: dict[str, Any], timeout: float = 20.0) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(f"{TELEGRAM_API}/{method}", json=payload)
        response.raise_for_status()
        return response.json()


async def send_message(chat_id: int | str, text: str, reply_to_message_id: int | None = None) -> None:
    chunks = [text[index:index + 3900] for index in range(0, len(text), 3900)] or [""]
    for chunk in chunks:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": chunk,
            "disable_web_page_preview": True,
        }
        if reply_to_message_id:
            payload["reply_to_message_id"] = reply_to_message_id
        try:
            await telegram("sendMessage", payload)
        except Exception as exc:
            print(f"Error sending Telegram message: {exc}", file=sys.stderr)


async def ask_coveragedesk_agent(message: dict[str, Any], text: str) -> str:
    chat = message.get("chat") or {}
    user = message.get("from") or {}
    payload = {
        "channel": "telegram",
        "chat_id": str(chat.get("id", "")),
        "user_name": user.get("username") or user.get("first_name") or "telegram",
        "message": clean_user_text(text),
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(f"{API_BASE_URL}/api/agent/chat", json=payload)
        response.raise_for_status()
        data = response.json()
    return data.get("reply") or "LineEdge did not return a reply."


async def poll_telegram_updates() -> None:
    if not BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is required")

    offset = 0
    print("LineEdge Telegram agent bridge started.")

    async with httpx.AsyncClient(timeout=70.0) as client:
        while True:
            try:
                response = await client.get(
                    f"{TELEGRAM_API}/getUpdates",
                    params={"offset": offset, "timeout": 50},
                )
                response.raise_for_status()
                updates = response.json().get("result", [])

                for update in updates:
                    offset = update["update_id"] + 1
                    message = update.get("message") or update.get("channel_post") or {}
                    text = (message.get("text") or "").strip()
                    chat = message.get("chat") or {}
                    chat_id = chat.get("id")
                    message_id = message.get("message_id")

                    if not chat_id or not text:
                        continue
                    if not is_allowed_chat(chat_id):
                        continue
                    if not should_answer(message, text):
                        continue

                    if text.lower().startswith(("/start", "/help")):
                        reply = (
                            "Talk to LineEdge here the same way you would talk to the site agent.\n\n"
                            "Ask about a matchup, why a line is rated or unrated, what the latest agent read is, "
                            "or what changes once the token CA is configured. The agent uses the same backend board, "
                            "thought log, and execution state as coveragedesk.online."
                        )

                    else:
                        reply = await ask_coveragedesk_agent(message, text)

                    await send_message(chat_id, reply, message_id)
            except Exception as exc:
                print(f"Telegram polling loop exception: {exc}", file=sys.stderr)
                await asyncio.sleep(5)


if __name__ == "__main__":
    asyncio.run(poll_telegram_updates())
