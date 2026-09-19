# CoverageDesk Agent Instructions

CoverageDesk is a React/Vite frontend with a FastAPI backend, autonomous AI sports spread agent, tokenomics ledger, and holder steering engine.

## Guardrails

- Never commit API keys, private keys, `.env` files, or server-only config.
- Keep agent thoughts, bets, token stats, holder dividends, and steering logic consistent across backend and frontend.
- Maintain independent hosting for `coveragedesk.online` on port `8800` without replacing or modifying `markbets.miono.live` (port 8799).

## Validation

Run the smallest relevant checks before committing:

```bash
npm run build
python -m py_compile backend/main.py backend/agent_engine.py
```

## Deployment Shape

- Static frontend builds to `dist`.
- FastAPI runs on `127.0.0.1:8800`.
- Automated agent decision loop processes spread lines, generates thoughts, executes bets, burns 50% of win profits, and pays out 50% to >1% holders.

