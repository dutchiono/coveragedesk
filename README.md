# MarcBets Coverage Desk

Static React/Vite dashboard for NFL and NCAA spread coverage analysis.

## What is included

- Live spread ingestion from The Odds API
- NFL and NCAA FBS sport keys
- Multi-book consensus spread by game
- No-vig market probability
- Uploaded team power ratings with injury/form adjustments
- Separate NFL/NCAAF home-field controls
- Model fair spread, model edge, coverage probability, and reliability score
- Game-detail view
- Historical model-performance and probability-band view
- Demo mode without an API key
- CSV export

## Local development

```bash
npm install
npm run dev
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

The app is static, so it fits the existing deploy helper:

```bash
/srv/drink/bin/add-site.sh marcbets marcbets.miono.live https://github.com/dutchiono/marcbets.git main "npm run build" dist
```

For wildcard hosting, nginx and DNS still need root/admin setup:

```dns
A  marcbets.miono.live    198.71.54.203
A  *.marcbets.miono.live  198.71.54.203
```

Nginx should use:

```nginx
server_name marcbets.miono.live *.marcbets.miono.live;
root /srv/drink/www/marcbets.miono.live/current;
```

Wildcard HTTPS requires DNS-01 validation, not the normal HTTP certbot flow.

## Secrets

Do not commit API keys or `.env` files. The browser app only uses an Odds API key pasted by the user for the current session.

## Current limitation

If The Odds API blocks browser-origin requests, add a small backend proxy and point nginx at it for `/api`. The dashboard is otherwise ready as a static build.
