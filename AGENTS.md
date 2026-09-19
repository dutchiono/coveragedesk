# MarkBets Agent Instructions

MarkBets is a React/Vite frontend with a FastAPI backend.

## Guardrails

- Never commit API keys, Telegram tokens, private keys, `.env` files, or server-only config.
- Keep Telegram-requested changes small and reversible.
- Do not add trading, order placement, wallet, portfolio, or account-management behavior.
- Prefer read-only market data integrations unless explicitly reviewed by the repo owner.
- For UI edits, keep the board compact and non-technical.

## Validation

Run the smallest relevant checks before committing:

```bash
npm run build
python -m py_compile backend/main.py backend/telegram_agent.py
```

## Deployment Shape

- Static frontend builds to `dist`.
- FastAPI runs on `127.0.0.1:8799`.
- Optional Telegram/OpenCode bridge runs separately and should only be enabled with server env vars.
