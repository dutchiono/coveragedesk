# Telegram OpenCode Agent

This repo includes an optional Telegram bridge for small MarkBets adjustments.

The flow is:

1. Authorized Telegram user sends `/adjust ...`.
2. `backend/telegram_agent.py` creates a fresh branch from `main`.
3. OpenCode runs the project agent `.opencode/agents/telegram-small-adjuster.md`.
4. The bridge rejects oversized diffs.
5. It runs validation, commits, pushes the branch, and opens a PR when `gh` is available.

## Required Server Environment

Set these on the server only. Do not commit them.

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_CHAT_IDS=123456789
OPENCODE_API_KEY=...
MARKBETS_REPO_DIR=/srv/drink/apps/markbets
```

Optional:

```bash
OPENCODE_BIN=opencode
OPENCODE_MODEL=opencode/gpt-5.1-codex
OPENCODE_AGENT=telegram-small-adjuster
TELEGRAM_MAX_CHANGED_FILES=8
TELEGRAM_MAX_CHANGED_LINES=450
```

GitHub PR creation also needs `gh` installed and authenticated, or a usable `GITHUB_TOKEN`.

## Install OpenCode On The Box

OpenCode documents these install options:

```bash
npm install -g opencode-ai
```

or:

```bash
curl -fsSL https://opencode.ai/install | bash
```

Then confirm:

```bash
opencode --version
```

## Run Manually

```bash
cd /srv/drink/apps/markbets
backend/.venv/bin/python backend/telegram_agent.py
```

## Systemd Service

Example:

```ini
[Unit]
Description=MarkBets Telegram OpenCode Agent
After=network.target

[Service]
User=drink
WorkingDirectory=/srv/drink/apps/markbets
EnvironmentFile=/srv/drink/apps/markbets/backend/.telegram-agent.env
ExecStart=/srv/drink/apps/markbets/backend/.venv/bin/python backend/telegram_agent.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Telegram Usage

```text
/id
/adjust Change the board title to say "Best cover spots"
```

Keep requests small. The bridge is intentionally not for trading, secrets, server changes, or large features.
