# CoverageDesk Protocol

React/Vite dashboard plus FastAPI backend for autonomous sports spread market monitoring, AI agent decision engine, tokenomics ($COVERAGE), win buybacks & burns, holder dividend distributions, and holder steering.

## What is included

- Autonomous AI Betting Agent & Live Thought Log Stream
- Tokenomics Ledger ($COVERAGE) & Bankroll Management
- **50% Buyback & Burn**: Half of net profits from winning bets automatically buy back and burn $COVERAGE
- **50% Holder Dividends**: Half of net profits from winning bets distributed pro-rata to holders with **> 1%** supply
- **Holder Steering Engine**: Holders with **≥ 0.5%** supply can burn tokens to inject strategy weights (underdog bias, sport focus, edge threshold, strategy directive)
- Backend spread ingestion from The Odds API & read-only Kalshi fallback
- Blue Chip Analytics enrichment for NCAAF model line, gap, and weather impact
- Shared agent chat endpoint for the website and Telegram. Telegram talks to the same backend board, thought log, token state, and scheduled decision loop rather than running parallel bot logic.
- Independent server deployment configuration for `coveragedesk.online` (Port 8800)

## Local development

Frontend:

```bash
npm install
npm run dev
```

Backend:

```bash
cd backend
python -m venv .venv
.venv/bin/pip install -r requirements.txt
COVERAGEDESK_DB=data/coveragedesk.sqlite3 .venv/bin/uvicorn main:app --host 127.0.0.1 --port 8800
```

Agent loop and chat:

```bash
# defaults to true and 1 hour
COVERAGEDESK_AGENT_AUTORUN=true
COVERAGEDESK_AGENT_INTERVAL_SECONDS=3600

# shared website/Telegram chat model
OPENCODE_API_KEY=...
OPENCODE_API_BASE_URL=https://api.opencode.ai/v1
OPENCODE_CHAT_MODEL=opencode/gpt-5.1-codex
```

Telegram bridge:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=coveragedesk_bot
COVERAGEDESK_API=http://127.0.0.1:8800
```

Do not expose manual agent-run controls in the frontend. The backend loop owns scheduled reads and any future execution.

## Production build

```bash
npm run build
```

Output directory: `dist`

## Deploy on the box (`coveragedesk.online`)

Add site with server deploy script:

```bash
/srv/drink/bin/add-site.sh coveragedesk coveragedesk.online https://github.com/dutchiono/coveragedesk.git main "npm run build" dist
```

FastAPI systemd service running on `127.0.0.1:8800`:

```nginx
server {
    listen 80;
    listen 443 ssl http2;
    server_name coveragedesk.online www.coveragedesk.online *.coveragedesk.online;

    root /srv/drink/www/coveragedesk.online/current;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:8800/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

