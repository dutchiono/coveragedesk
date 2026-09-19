# MarkBets Coverage Desk

Static React/Vite dashboard for NFL and NCAA spread coverage analysis.

## What is included

- Live spread ingestion from The Odds API
- NFL and NCAA FBS sport keys
- Multi-book consensus spread by game
- No-vig market probability
- Managed team power ratings with injury/form adjustments
- Separate NFL/NCAAF home-field controls
- Model fair spread, model edge, coverage probability, and reliability score
- Game-detail view
- Historical model-performance and probability-band view
- Demo mode without an API key
- CSV export

## Data updates

Ratings and historical calibration data are managed in GitHub, not uploaded through the browser.

Agents should update these files in the repo and push to `main`:

```text
public/data/ratings.csv
public/data/historical_training.csv
```

The app fetches those CSV files when it loads. The box deploy cron should then pull, rebuild, and publish the latest data.

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
/srv/drink/bin/add-site.sh markbets markbets.miono.live https://github.com/dutchiono/markbets.git main "npm run build" dist
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

Do not commit API keys or `.env` files. The browser app only uses an Odds API key pasted by the user for the current session.

## Current limitation

If The Odds API blocks browser-origin requests, add a small backend proxy and point nginx at it for `/api`. The dashboard is otherwise ready as a static build.
