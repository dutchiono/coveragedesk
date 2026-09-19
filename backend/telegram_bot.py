import asyncio
import os
import sys
from typing import Any

import httpx

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
BOT_USERNAME = os.getenv("TELEGRAM_BOT_USERNAME", "coveragedesk_bot").strip().lower().lstrip("@")
BOT_ID: int | None = None
API_BASE_URL = os.getenv("COVERAGEDESK_API", "http://127.0.0.1:8800").rstrip("/")
TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"
ALLOWED_CHAT_IDS = {
    value.strip()
    for value in os.getenv("TELEGRAM_ALLOWED_CHAT_IDS", "").split(",")
    if value.strip()
}

SPECIFIC_BOT_COMMANDS = {
    "/spreads",
    "/token",
    "/agent",
    "/steer",
    "/lineedge",
    "/coveragedesk",
    "/markets",
}


def is_allowed_chat(chat_id: int | str) -> bool:
    return not ALLOWED_CHAT_IDS or str(chat_id) in ALLOWED_CHAT_IDS


async def fetch_bot_info() -> None:
    global BOT_ID, BOT_USERNAME
    if not BOT_TOKEN:
        return
    try:
        data = await telegram("getMe", {})
        result = data.get("result") or {}
        if result.get("id"):
            BOT_ID = result["id"]
        if result.get("username"):
            BOT_USERNAME = result["username"].lower().lstrip("@")
    except Exception as exc:
        print(f"Warning: Could not fetch Telegram getMe info: {exc}", file=sys.stderr)


def should_answer(message: dict[str, Any], text: str) -> bool:
    chat = message.get("chat") or {}
    chat_type = chat.get("type", "private")

    # 1. Private DMs with the bot always answer
    if chat_type == "private":
        return True

    lowered = text.lower().strip()
    words = lowered.split()
    first_word = words[0] if words else ""

    # 2. Check if user is replying directly to a message sent BY THIS BOT
    reply_to = message.get("reply_to_message") or {}
    reply_from = reply_to.get("from") or {}
    is_reply_to_this_bot = False
    if reply_from:
        if BOT_ID and reply_from.get("id") == BOT_ID:
            is_reply_to_this_bot = True
        elif (
            reply_from.get("username")
            and reply_from.get("username").lower().lstrip("@") == BOT_USERNAME
        ):
            is_reply_to_this_bot = True

    if is_reply_to_this_bot:
        return True

    # 3. Check if user explicitly @mentions this bot
    if f"@{BOT_USERNAME}" in lowered:
        return True

    # 4. Check if user sent a specific slash command for THIS bot
    if first_word.startswith("/"):
        # If command has an @ target (e.g. /start@MissRose_bot or /rules@MissRose_bot):
        if "@" in first_word:
            cmd_target = first_word.split("@")[-1].lower().lstrip("@")
            if cmd_target == BOT_USERNAME:
                return True
            # Targeted at Rose or another bot -> NEVER answer
            return False

        # Specific protocol commands intended for this bot:
        if first_word in SPECIFIC_BOT_COMMANDS:
            return True

    # For ALL other group messages, replies to other users, and generic /start /help commands: IGNORE
    return False


def clean_user_text(text: str) -> str:
    cleaned = text.replace(f"@{BOT_USERNAME}", "").replace(f"@{BOT_USERNAME.upper()}", "")
    return cleaned.strip() or "What is the current market read?"


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

    await fetch_bot_info()
    offset = 0
    print(f"LineEdge Telegram agent bridge started for @{BOT_USERNAME} (ID: {BOT_ID}).")

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

                    first_word = text.lower().strip().split()[0] if text.strip() else ""
                    if first_word in {"/start", "/help"} or first_word.startswith(("/start@", "/help@")):
                        reply = (
                            f"👋 Welcome! I am the sports & prediction market agent watching the board.\n\n"
                            f"Mention me (@{BOT_USERNAME}) or reply to my messages to ask about matchups, "
                            f"model edges, orderbook arbitrage, or agent reasoning.\n\n"
                            f"Commands:\n"
                            f"• /spreads - View top model spread edges\n"
                            f"• /token - View buybacks, burns & holder dividend stats\n"
                            f"• /agent - Read AI agent market reasoning & bets\n"
                            f"• /steer - How to steer game lines"
                        )
                    else:
                        reply = await ask_coveragedesk_agent(message, text)

                    await send_message(chat_id, reply, message_id)
            except Exception as exc:
                print(f"Telegram polling loop exception: {exc}", file=sys.stderr)
                await asyncio.sleep(5)


if __name__ == "__main__":
    asyncio.run(poll_telegram_updates())
