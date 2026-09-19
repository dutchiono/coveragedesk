import asyncio
import os
import re
import sys
import time
from typing import Any
import httpx

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "8628784169:AAF5yfdCQD6x67FWmfuLx2RPseAZRzPU9mA")
API_BASE_URL = os.getenv("COVERAGEDESK_API", "http://127.0.0.1:8800")
TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"


async def get_board_summary() -> str:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(f"{API_BASE_URL}/api/board")
            if res.status_code == 200:
                data = res.json()
                rows = data.get("rows", [])
                if not rows:
                    return "📊 *CoverageDesk Market Board*\nNo active spread lines currently on the board."
                
                msg = ["🏈 *Top CoverageDesk Spread Edges*\n"]
                for i, r in enumerate(rows[:5], 1):
                    away = r.get("away_team", "")
                    home = r.get("home_team", "")
                    sport = r.get("sport", "")
                    gap = r.get("metrics", {}).get("model_market_gap")
                    gap_str = f"+{gap:.1f}" if gap and gap > 0 else f"{gap:.1f}" if gap else "N/A"
                    rating = r.get("rating", {}).get("grade", "Even")
                    consensus = r.get("market", {}).get("consensus_spread", "N/A")
                    msg.append(f"*{i}. {away} vs {home}* ({sport})")
                    msg.append(f"   Line: `{consensus}` | Model Gap: `{gap_str} pts` | Rating: `{rating}`\n")
                
                msg.append("🔗 View live board & steer lines: https://coveragedesk.online")
                return "\n".join(msg)
    except Exception as exc:
        return f"Error fetching spread board: {exc}"
    return "Could not load market board."


async def get_token_summary() -> str:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(f"{API_BASE_URL}/api/agent/token-stats")
            if res.status_code == 200:
                s = res.json()
                msg = [
                    "🔥 *Coverage ($CVR) Tokenomics & Dividend Metrics*\n",
                    f"• *Token Ticker*: `$CVR`",
                    f"• *Total Supply*: `{s.get('total_supply', 1e9):,.0f} $CVR`",
                    f"• *Agent Betting Bankroll*: `{s.get('bankroll_balance', 0):,.0f} $CVR`",
                    f"• *🔥 Total 50% Buyback Burned*: `{s.get('total_burned', 0):,.0f} $CVR`",
                    f"• *💰 Total 50% Holder Dividends*: `{s.get('total_distributed', 0):,.0f} $CVR`",
                    f"• *Agent Win Rate*: `{s.get('win_rate', 0.70)*100:.0f}%` ({s.get('total_wins', 0)}W / {s.get('total_losses', 0)}L)\n",
                    "• *Dividend Tier*: Holders owning *> 1.0%* supply receive automatic 50% net win profit payouts.",
                    "• *Steering Tier*: Holders owning *≥ 0.5%* supply can burn $CVR to weight specific game lines!",
                    "\n🔗 https://coveragedesk.online"
                ]
                return "\n".join(msg)
    except Exception as exc:
        return f"Error fetching token stats: {exc}"
    return "Could not load token stats."


async def get_agent_summary() -> str:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(f"{API_BASE_URL}/api/agent/thoughts?limit=3")
            if res.status_code == 200:
                data = res.json()
                thoughts = data.get("thoughts", [])
                if not thoughts:
                    return "🧠 *CoverageDesk AI Agent Terminal*\nAgent monitoring market board for edge opportunities."
                
                msg = ["🧠 *CoverageDesk AI Agent - Latest Market Reasoning*\n"]
                for t in thoughts:
                    matchup = t.get("matchup", "")
                    thought = t.get("thought", "")
                    conf = t.get("confidence", 0.70)
                    msg.append(f"• *{matchup}* (Confidence: {conf*100:.0f}%):")
                    msg.append(f"  _{thought}_\n")
                
                return "\n".join(msg)
    except Exception as exc:
        return f"Error fetching agent thoughts: {exc}"
    return "Could not load agent thoughts."


def get_steering_help() -> str:
    return (
        "🎯 *CoverageDesk Line Steering Instructions*\n\n"
        "Holders owning *≥ 0.5%* of total `$CVR` supply (5,000,000+ tokens) can burn $CVR to steer the AI agent's decision engine!\n\n"
        "1. Connect your holder wallet on https://coveragedesk.online\n"
        "2. Select any game line on the Coverage Market Board.\n"
        "3. Click *🎯 Steer Line ($CVR)* right on the game card.\n"
        "4. Choose your burn amount and strategy bias to weight that matchup!\n\n"
        "🔥 100% of tokens burned for line steering are permanently removed from supply."
    )


async def send_message(chat_id: int | str, text: str, reply_to_message_id: int | None = None) -> None:
    async with httpx.AsyncClient(timeout=10.0) as client:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown",
            "disable_web_page_preview": True,
        }
        if reply_to_message_id:
            payload["reply_to_message_id"] = reply_to_message_id
        try:
            await client.post(f"{TELEGRAM_API}/sendMessage", json=payload)
        except Exception as exc:
            print(f"Error sending Telegram message: {exc}", file=sys.stderr)


async def poll_telegram_updates() -> None:
    offset = 0
    print("🤖 CoverageDesk Telegram Assistant & Moderator Bot Started!")
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        while True:
            try:
                res = await client.get(f"{TELEGRAM_API}/getUpdates", params={"offset": offset, "timeout": 20})
                if res.status_code != 200:
                    await asyncio.sleep(3)
                    continue

                updates = res.json().get("result", [])
                for update in updates:
                    offset = update["update_id"] + 1
                    message = update.get("message") or update.get("channel_post")
                    if not message or "text" not in message:
                        continue

                    chat_id = message["chat"]["id"]
                    msg_id = message["message_id"]
                    text = message["text"].strip()
                    lower_text = text.lower()

                    # Check if bot is mentioned or commanded
                    is_mentioned = "@coveragedesk_bot" in lower_text or text.startswith("/") or message.get("chat", {}).get("type") == "private"

                    if not is_mentioned:
                        continue

                    print(f"Processing Telegram message from chat {chat_id}: {text}")

                    if "/start" in lower_text or "/help" in lower_text or "help" in lower_text:
                        reply = (
                            "👋 *Welcome to CoverageDesk Assistant & Moderator Bot!*\n\n"
                            "I monitor sports spread markets, AI betting thoughts, `$CVR` tokenomics, and holder line steering.\n\n"
                            "Commands & Queries:\n"
                            "• `/spreads` - View top model spread edges\n"
                            "• `/token` - View `$CVR` buybacks, burns & holder dividend stats\n"
                            "• `/agent` - Read AI agent market reasoning & bets\n"
                            "• `/steer` - How to burn `$CVR` and steer game lines\n\n"
                            "🌐 *Website*: https://coveragedesk.online"
                        )
                        await send_message(chat_id, reply, msg_id)
                    elif "/spread" in lower_text or "edge" in lower_text or "lines" in lower_text:
                        reply = await get_board_summary()
                        await send_message(chat_id, reply, msg_id)
                    elif "/token" in lower_text or "stats" in lower_text or "cvr" in lower_text or "dividend" in lower_text or "burn" in lower_text:
                        reply = await get_token_summary()
                        await send_message(chat_id, reply, msg_id)
                    elif "/agent" in lower_text or "thought" in lower_text or "reason" in lower_text:
                        reply = await get_agent_summary()
                        await send_message(chat_id, reply, msg_id)
                    elif "/steer" in lower_text or "steering" in lower_text:
                        reply = get_steering_help()
                        await send_message(chat_id, reply, msg_id)
                    else:
                        reply = (
                            f"🤖 *CoverageDesk Bot Assistant*\n"
                            f"I'm here to help! Ask me about top spread edges, agent thoughts, `$CVR` tokenomics, or line steering.\n\n"
                            f"Type `/spreads`, `/token`, `/agent`, or visit https://coveragedesk.online"
                        )
                        await send_message(chat_id, reply, msg_id)

            except Exception as exc:
                print(f"Polling loop exception: {exc}", file=sys.stderr)
                await asyncio.sleep(5)


if __name__ == "__main__":
    asyncio.run(poll_telegram_updates())
