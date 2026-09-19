# MarkBets Coverage Desk

React/Vite dashboard plus FastAPI backend for NFL and NCAA spread-market monitoring.

## What is included

- Backend spread ingestion from The Odds API when configured
- Read-only Kalshi football spread contracts as the live fallback
- Blue Chip Analytics enrichment for NCAAF model line, gap, source URL, and weather
- NFL and NCAA FBS sport keys
- Multi-book consensus spread by game
- SQLite line-history storage
- Consensus spread, best available lines, opening/current movement
- Optional backend model projection CSV
- Model-vs-market gap and reliability score
- Game-detail view
- Preview fallback only when the backend itself is unavailable

## Data updates

Model projections are managed by the backend, not uploaded through the browser.

Agents should update these files in the repo and push to `main`:

```text
backend/data/projections.csv
```

The backend reads that file and compares it with live sportsbook consensus rows.
When `ODDS_API_KEY` is not configured, `/api/board` still returns live Kalshi
football spread contracts and enriches NCAAF rows from Blue Chip Analytics.

Required environment for live odds:

```text
ODDS_API_KEY=...
```

## Local development

```bash
npm install
npm run dev
```

Backend:

```bash
cd backend
python -m venv .venv
.venv/bin/pip install -r requirements.txt
ODDS_API_KEY=... .venv/bin/uvicorn main:app --host 127.0.0.1 --port 8799
```

## Production build

```bash
npm run build
```

Output directory:

```text
dist
```

## Deploy on the box

The frontend still fits the existing deploy helper:

```bash
/srv/drink/bin/add-site.sh markbets markbets.miono.live https://github.com/dutchiono/markbets.git main "npm run build" dist
```

The backend should run as a local service on `127.0.0.1:8799`, and nginx should proxy:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8799/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

For wildcard hosting, nginx and DNS still need root/admin setup:

```dns
A  markbets.miono.live    198.71.54.203
A  *.markbets.miono.live  198.71.54.203
```

Nginx should use:

```nginx
server_name markbets.miono.live *.markbets.miono.live;
root /srv/drink/www/markbets.miono.live/current;
```

Wildcard HTTPS requires DNS-01 validation, not the normal HTTP certbot flow.

## Secrets

Do not commit API keys or `.env` files. `ODDS_API_KEY` belongs on the server.
