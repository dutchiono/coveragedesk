import csv
import asyncio
import html
import json
import math
import os
import re
import sqlite3
import statistics
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
import agent_engine

API_URL = "https://api.the-odds-api.com/v4/sports/{sport}/odds"
SPORTS = {"NFL": "americanfootball_nfl", "NCAAF": "americanfootball_ncaaf"}
KALSHI_API_URL = "https://external-api.kalshi.com/trade-api/v2"
KALSHI_SPREAD_SERIES = {"NFL": "KXNFLSPREAD", "NCAAF": "KXNCAAFSPREAD"}
KALSHI_MARKET_SERIES = {
  ("NFL", "spread"): "KXNFLSPREAD",
  ("NFL", "total"): "KXNFLTOTAL",
  ("NFL", "moneyline"): "KXNFLGAME",
  ("NCAAF", "spread"): "KXNCAAFSPREAD",
  ("NCAAF", "total"): "KXNCAAFTOTAL",
  ("NCAAF", "moneyline"): "KXNCAAFGAME",
}
BLUECHIP_WEEK_URL = os.getenv("BLUECHIP_WEEK_URL", "https://bluechipanalytics.com/college-football/games/2026/week3/")
BLUECHIP_CACHE_SECONDS = int(os.getenv("BLUECHIP_CACHE_SECONDS", "1800"))
KALSHI_INCLUDE_UNMODELED = os.getenv("KALSHI_INCLUDE_UNMODELED", "true").lower() in {"1", "true", "yes"}
AGENT_AUTORUN_ENABLED = os.getenv("COVERAGEDESK_AGENT_AUTORUN", "true").lower() in {"1", "true", "yes"}
AGENT_INTERVAL_SECONDS = max(60, int(os.getenv("COVERAGEDESK_AGENT_INTERVAL_SECONDS", "3600")))
COVERAGEDESK_TOKEN_CA = (
  os.getenv("COVERAGEDESK_TOKEN_CA")
  or os.getenv("COVERAGE_TOKEN_CA")
  or os.getenv("CVR_TOKEN_CA")
  or "EJWD6ZTMTE2NdQtwgcLcDFNecueuUhZMxx4WNGospump"
).strip()


COVERAGEDESK_TOKEN_SYMBOL = os.getenv("COVERAGEDESK_TOKEN_SYMBOL", "$LINE").strip() or "$LINE"
OPENCODE_API_KEY = os.getenv("OPENCODE_API_KEY", "").strip()
OPENCODE_API_BASE_URL = os.getenv("OPENCODE_API_BASE_URL", "https://api.opencode.ai/v1").rstrip("/")
OPENCODE_CHAT_MODEL = os.getenv("OPENCODE_CHAT_MODEL") or os.getenv("OPENCODE_MODEL") or "opencode/gpt-5.1-codex"
OPENCODE_CHAT_TEMPERATURE = float(os.getenv("OPENCODE_CHAT_TEMPERATURE", "0.2"))

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("COVERAGEDESK_DB", ROOT / "data" / "coveragedesk.sqlite3"))
PROJECTIONS_PATH = Path(os.getenv("COVERAGEDESK_PROJECTIONS", ROOT / "data" / "projections.csv"))

app = FastAPI(title="LineEdge API")

BLUECHIP_CACHE: dict[str, Any] = {"expires_at": 0.0, "games": {}}
AGENT_TASK: asyncio.Task[None] | None = None


def now_iso() -> str:
  return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


async def agent_autorun_loop() -> None:
  while True:
    try:
      await agent_tick()
    except asyncio.CancelledError:
      raise
    except Exception as exc:
      print(f"[CoverageDesk] agent loop failed: {exc}")
    await asyncio.sleep(AGENT_INTERVAL_SECONDS)


@app.on_event("startup")
async def start_agent_autorun() -> None:
  global AGENT_TASK
  if not AGENT_AUTORUN_ENABLED:
    return
  if AGENT_TASK is None or AGENT_TASK.done():
    AGENT_TASK = asyncio.create_task(agent_autorun_loop())


@app.on_event("shutdown")
async def stop_agent_autorun() -> None:
  global AGENT_TASK
  if AGENT_TASK is None:
    return
  AGENT_TASK.cancel()
  try:
    await AGENT_TASK
  except asyncio.CancelledError:
    pass
  AGENT_TASK = None


def canonical_id(sport: str, commence_time: str, away_team: str, home_team: str) -> str:
  date = commence_time[:10].replace("-", "_")
  slug = "_".join([sport.lower(), date, slugify(away_team), slugify(home_team)])
  return slug


def slugify(value: str) -> str:
  return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


TEAM_ALIASES = {
    "nc_state": "north_carolina_state",
    "n_c_state": "north_carolina_state",
    "ole_miss": "mississippi",
    "appalachian_state": "app_state",
    "appalachian_st": "app_state",
    "penn_st": "penn_state",
    "ohio_st": "ohio_state",
    "oklahoma_st": "oklahoma_state",
    "michigan_st": "michigan_state",
    "arizona_st": "arizona_state",
    "florida_st": "florida_state",
    "kansas_st": "kansas_state",
    "boise_st": "boise_state",
    "fresno_st": "fresno_state",
    "san_jose_st": "san_jose_state",
    "san_diego_st": "san_diego_state",
    "colorado_st": "colorado_state",
    "utah_st": "utah_state",
    "washington_st": "washington_state",
    "oregon_st": "oregon_state",
}


def matchup_key(away_team: str, home_team: str) -> str:
  return "|".join(sorted([team_key(away_team), team_key(home_team)]))


def team_key(value: str) -> str:
  normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
  normalized = re.sub(r"\bst[.]?\b", "state", normalized, flags=re.I)
  normalized = normalized.replace("&", " and ")
  slug = slugify(normalized)
  return TEAM_ALIASES.get(slug, slug)



def connect() -> sqlite3.Connection:
  DB_PATH.parent.mkdir(parents=True, exist_ok=True)
  conn = sqlite3.connect(DB_PATH)
  conn.row_factory = sqlite3.Row
  conn.execute(
    """
    CREATE TABLE IF NOT EXISTS odds_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      sport TEXT NOT NULL,
      commence_time TEXT NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      book TEXT NOT NULL,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      line REAL,
      price INTEGER,
      captured_at TEXT NOT NULL
    )
    """
  )
  conn.execute("CREATE INDEX IF NOT EXISTS idx_odds_game ON odds_snapshots(game_id, captured_at)")

  conn.execute(
    """
    CREATE TABLE IF NOT EXISTS agent_thoughts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      matchup TEXT NOT NULL,
      thought TEXT NOT NULL,
      confidence REAL NOT NULL,
      edge REAL NOT NULL,
      bet_placed INTEGER NOT NULL,
      steering_influences TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
    """
  )

  conn.execute(
    """
    CREATE TABLE IF NOT EXISTS agent_bets (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      matchup TEXT NOT NULL,
      sport TEXT NOT NULL,
      bet_side TEXT NOT NULL,
      line REAL NOT NULL,
      odds INTEGER NOT NULL,
      stake REAL NOT NULL,
      status TEXT NOT NULL,
      payout REAL NOT NULL,
      buyback_burned REAL NOT NULL,
      dividend_distributed REAL NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
    """
  )

  conn.execute(
    """
    CREATE TABLE IF NOT EXISTS agent_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
    """
  )
  conn.execute("CREATE INDEX IF NOT EXISTS idx_agent_chat_channel ON agent_chat_messages(channel, chat_id, created_at)")

  conn.execute(
    """
    CREATE TABLE IF NOT EXISTS token_stats (
      id INTEGER PRIMARY KEY,
      total_supply REAL NOT NULL,
      bankroll_balance REAL NOT NULL,
      total_fees_collected REAL NOT NULL,
      total_burned REAL NOT NULL,
      total_distributed REAL NOT NULL,
      total_wins INTEGER NOT NULL,
      total_losses INTEGER NOT NULL,
      win_rate REAL NOT NULL,
      updated_at TEXT NOT NULL
    )
    """
  )

  conn.execute(
    """
    CREATE TABLE IF NOT EXISTS holder_ledger (
      address TEXT PRIMARY KEY,
      balance REAL NOT NULL,
      percentage REAL NOT NULL,
      is_dividend_eligible INTEGER NOT NULL,
      is_steering_eligible INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
    """
  )

  conn.execute(
    """
    CREATE TABLE IF NOT EXISTS steering_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL DEFAULT '',
      holder_address TEXT NOT NULL,
      burned_tokens REAL NOT NULL,
      underdog_bias REAL NOT NULL,
      ncaaf_weight REAL NOT NULL,
      nfl_weight REAL NOT NULL,
      min_edge_threshold REAL NOT NULL,
      custom_directive TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
    """
  )
  try:
    conn.execute("ALTER TABLE steering_events ADD COLUMN game_id TEXT DEFAULT ''")
  except Exception:
    pass

  conn.execute(
    """
    CREATE TABLE IF NOT EXISTS burn_and_payout_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bet_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      amount REAL NOT NULL,
      recipients_count INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )
    """
  )

  if not COVERAGEDESK_TOKEN_CA:
    conn.commit()
    return conn

  # Seed token stats only after the real token contract address is configured.
  cursor = conn.cursor()
  cursor.execute("SELECT COUNT(*) FROM token_stats")
  if cursor.fetchone()[0] == 0:
    conn.execute(
      """
      INSERT INTO token_stats (id, total_supply, bankroll_balance, total_fees_collected, total_burned, total_distributed, total_wins, total_losses, win_rate, updated_at)
      VALUES (1, 1000000000.0, 50000.0, 75000.0, 12500.0, 12500.0, 14, 6, 0.70, ?)
      """,
      (now_iso(),)
    )

  # Seed sample holders if empty
  cursor.execute("SELECT COUNT(*) FROM holder_ledger")
  if cursor.fetchone()[0] == 0:
    sample_holders = [
      ("7xKXp9...Whale1", 25_000_000.0, 2.50, 1, 1),
      ("3mPq2...Whale2", 18_000_000.0, 1.80, 1, 1),
      ("9zLw4...AlphaHolder", 12_000_000.0, 1.20, 1, 1),
      ("5vRt8...SteeringHolder", 7_500_000.0, 0.75, 0, 1),
      ("2bNm1...SteeringHolder2", 6_000_000.0, 0.60, 0, 1),
      ("4kJs6...CommunityMember", 2_500_000.0, 0.25, 0, 0),
      ("1aXz3...RetailHolder", 500_000.0, 0.05, 0, 0),
    ]
    for addr, bal, pct, div_el, st_el in sample_holders:
      conn.execute(
        """
        INSERT INTO holder_ledger (address, balance, percentage, is_dividend_eligible, is_steering_eligible, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (addr, bal, pct, div_el, st_el, now_iso())
      )

  conn.commit()
  return conn


def american_to_probability(odds: int | None) -> float | None:
  if odds is None:
    return None
  return 100 / (odds + 100) if odds > 0 else -odds / (-odds + 100)


def dollars_to_float(value: Any) -> float | None:
  if value in (None, ""):
    return None
  try:
    return float(value)
  except (TypeError, ValueError):
    matches = re.findall(r"[+-]?\d+(?:\.\d+)?", str(value))
    return float(matches[-1]) if matches else None


def clean_html_text(value: str) -> str:
  text = re.sub(r"<[^>]+>", " ", value)
  text = html.unescape(text)
  return re.sub(r"\s+", " ", text).strip()


def parse_team_line(value: str | None) -> tuple[str | None, float | None]:
  if not value:
    return None, None
  text = clean_html_text(value)
  match = re.match(r"(.+?)\s+([+-]?\d+(?:\.\d+)?)$", text)
  if not match:
    return None, dollars_to_float(text)
  return match.group(1).strip(), abs(float(match.group(2)))


def bluechip_table_cell(row_html: str, class_name: str) -> str | None:
  match = re.search(rf'<td class="{re.escape(class_name)}"[^>]*>(.*?)</td>', row_html, flags=re.S)
  if not match:
    return None
  return clean_html_text(match.group(1))


def fp_to_float(value: Any) -> float:
  parsed = dollars_to_float(value)
  return parsed if parsed is not None else 0


def kalshi_price_cents(market: dict[str, Any], *keys: str) -> float | None:
  for key in keys:
    parsed = dollars_to_float(market.get(key))
    if parsed is None:
      continue
    if "dollars" in key or parsed <= 1:
      return round(parsed * 100, 2)
    return parsed
  return None


def clamp(value: float, minimum: float, maximum: float) -> float:
  return max(minimum, min(maximum, value))


def extract_matchup(market: dict[str, Any]) -> tuple[str, str]:
  rules = market.get("rules_primary") or ""
  match = re.search(r"in the (.+?) vs (.+?) (?:college football|Pro Football|NFL)", rules, flags=re.I)
  if not match:
    match = re.search(r"the (.+?) vs (.+?) (?:college football|Pro Football|NFL)", rules, flags=re.I)
  if match:
    return match.group(1).strip(), match.group(2).strip()
  title = (market.get("title") or "").replace("?", "")
  if " at " in title:
    parts = title.split(" at ")
    return parts[0].strip(), parts[1].strip()
  if " vs " in title:
    parts = title.split(" vs ")
    return parts[0].strip(), parts[1].strip()
  team = title.replace("Will the ", "").replace(" win", "").strip()
  return team, "Opponent"



def contract_side_type(market: dict[str, Any]) -> str | None:
  label = market.get("yes_sub_title") or market.get("title") or ""
  if not label:
    return None
  if "Over" in label:
    return "over"
  if "Under" in label:
    return "under"
  return "favorite"


def contract_side_team(market: dict[str, Any], bluechip: dict[str, Any]) -> str | None:
  label_key = team_key(market.get("yes_sub_title") or market.get("title") or "")
  candidates = [
    bluechip.get("away_team"),
    bluechip.get("home_team"),
    bluechip.get("market_team"),
    bluechip.get("model_team"),
  ]
  for candidate in candidates:
    if candidate and team_key(candidate) in label_key:
      return candidate
  return None


def contract_model_gap(
  bet_type: str,
  market: dict[str, Any],
  bluechip: dict[str, Any] | None,
  weather_impact: dict[str, Any] | None,
) -> float | None:
  threshold = dollars_to_float(market.get("floor_strike"))
  if threshold is None or not bluechip:
    return None

  if bet_type == "spread":
    model_spread = bluechip.get("model_spread")
    if model_spread is None:
      return None
    market_team = bluechip.get("market_team") or ""
    model_team = bluechip.get("model_team") or ""
    adjusted_model = model_spread
    if weather_impact and weather_impact.get("spread_adjustment"):
      adjusted_model += weather_impact["spread_adjustment"]
    side_team = contract_side_team(market, bluechip) or market_team
    if side_team and model_team and team_key(side_team) != team_key(model_team):
      return round(-adjusted_model - threshold, 1)
    gap = adjusted_model - threshold
    return round(gap, 1)

  if bet_type == "total":
    model_total = dollars_to_float(bluechip.get("model_total"))
    if model_total is None:
      return None
    if weather_impact and weather_impact.get("total_adjustment"):
      model_total += weather_impact["total_adjustment"]
    side_type = contract_side_type(market)
    if side_type == "over":
      return round(model_total - threshold, 1)
    if side_type == "under":
      return round(threshold - model_total, 1)

  return None


def rating_for_market(
  bet_type: str,
  market: dict[str, Any],
  bluechip: dict[str, Any] | None,
  weather_impact: dict[str, Any] | None,
  model_gap: float | None,
  cover_price: float | None,
) -> dict[str, Any]:
  if model_gap is None or cover_price is None or cover_price <= 0:
    return {
      "grade": "Even",
      "edge": 0.0,
      "summary": "Unmodeled market",
      "explanation": "No Blue Chip model benchmark available for this line yet.",
      "gap_points": 0.0,
      "price_edge_cents": 0.0,
    }

  fair_prob = clamp(0.5 + model_gap * 0.035, 0.05, 0.95)
  market_prob = cover_price / 100.0
  prob_edge = fair_prob - market_prob
  price_edge_cents = round(prob_edge * 100, 1)

  if model_gap >= 3.0 and prob_edge >= 0.08:
    grade = "Strong Buy"
    summary = f"Major model edge (+{model_gap:.1f} pts)"
  elif model_gap >= 1.5 and prob_edge >= 0.04:
    grade = "Buy"
    summary = f"Solid model edge (+{model_gap:.1f} pts)"
  elif model_gap <= -3.0 or prob_edge <= -0.08:
    grade = "Strong Avoid"
    summary = f"Market overpriced vs model ({model_gap:.1f} pts)"
  elif model_gap <= -1.5 or prob_edge <= -0.04:
    grade = "Avoid"
    summary = f"Model discount ({model_gap:.1f} pts)"
  else:
    grade = "Even"
    summary = f"Fairly priced line ({model_gap:+.1f} pts)"

  side_label = market.get("yes_sub_title") or market.get("title") or "Side"
  explanation = f"{summary}. Model projects {fair_prob * 100:.0f}% cover probability vs market price of {cover_price:.0f}¢ on {side_label}."
  return {
    "grade": grade,
    "edge": round(prob_edge, 3),
    "summary": summary,
    "explanation": explanation,
    "gap_points": model_gap,
    "price_edge_cents": price_edge_cents,
  }


def gap_confidence(gap: float | None) -> float:
  if gap is None:
    return 0.55
  return round(clamp(0.55 + abs(gap) * 0.05, 0.55, 0.95), 2)


async def fetch_bluechip_analytics() -> dict[str, Any]:
  now = time.time()
  if BLUECHIP_CACHE["expires_at"] > now and BLUECHIP_CACHE["games"]:
    return BLUECHIP_CACHE["games"]

  headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  }

  target_urls = [BLUECHIP_WEEK_URL]
  for week in range(1, 10):
    url = f"https://bluechipanalytics.com/college-football/games/2026/week{week}/"
    if url not in target_urls:
      target_urls.append(url)

  games: dict[str, Any] = {}

  async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, headers=headers) as client:
    responses = await asyncio.gather(*[client.get(url) for url in target_urls], return_exceptions=True)

    for resp in responses:
      if isinstance(resp, Exception) or resp.status_code != 200:
        continue
      page = resp.text

      card_matches = re.findall(
        r'<div class="matchup-header text-center">.*?<a href="([^"]+)".*?class="matchup-link">([^<]+)</a>.*?<div class="team text-end">.*?<div class="team-name">([^<]+)</div>.*?<div class="team-name">([^<]+)</div>',
        page,
        flags=re.S,
      )

      for rel_url, title, away, home in card_matches:
        full_url = rel_url if rel_url.startswith("http") else f"https://bluechipanalytics.com{rel_url}"
        key = matchup_key(away, home)
        games[key] = {
          "url": full_url,
          "title": html.unescape(title.strip()),
          "away_team": html.unescape(away.strip()),
          "home_team": html.unescape(home.strip()),
          "source": "Blue Chip Analytics",
          "updated_at": now_iso(),
        }

      row_matches = re.findall(
        r'<tr>\s*<td><a href="([^"]+)">([^<]+)</a></td>\s*<td>([^<]*)</td>\s*<td>([^<]*)</td>\s*<td>([^<]*)</td>\s*<td>([^<]*)</td>\s*<td>([^<]*)</td>',
        page,
        flags=re.S,
      )

      for rel_url, matchup, m_line, m_team, md_line, md_team, gap in row_matches:
        teams = matchup.split(" vs ")
        if len(teams) != 2:
          continue
        key = matchup_key(teams[0], teams[1])
        game = games.setdefault(
          key,
          {
            "url": rel_url if rel_url.startswith("http") else f"https://bluechipanalytics.com{rel_url}",
            "title": matchup.strip(),
            "away_team": teams[0].strip(),
            "home_team": teams[1].strip(),
            "source": "Blue Chip Analytics",
            "updated_at": now_iso(),
          },
        )
        game["market_line"] = m_line.strip() or None
        game["market_team"] = m_team.strip() or None
        game["model_line"] = md_line.strip() or None
        game["model_team"] = md_team.strip() or None
        game["market_spread"] = dollars_to_float(m_line)
        game["model_spread"] = dollars_to_float(md_line)
        game["gap"] = dollars_to_float(gap)

      table_match = re.search(r'<tbody id="hub-game-table-body">(.*?)</tbody>', page, flags=re.S)
      if table_match:
        for row_html in re.findall(r"<tr>(.*?)</tr>", table_match.group(1), flags=re.S):
          href_match = re.search(r'href="([^"]+)"', row_html)
          team_cells = re.findall(r'<td class="team-col"[^>]*>(.*?)</td>', row_html, flags=re.S)
          if len(team_cells) < 2:
            continue

          away = clean_html_text(team_cells[0])
          home = clean_html_text(team_cells[1])
          if not away or not home:
            continue

          power_line = bluechip_table_cell(row_html, "powerline-col")
          market_line = bluechip_table_cell(row_html, "line-col")
          total = bluechip_table_cell(row_html, "ou-col")
          model_team, model_spread = parse_team_line(power_line)
          market_team, market_spread = parse_team_line(market_line)
          key = matchup_key(away, home)
          rel_url = href_match.group(1) if href_match else ""
          game = games.setdefault(
            key,
            {
              "url": rel_url if rel_url.startswith("http") else f"https://bluechipanalytics.com{rel_url}",
              "title": f"{away} vs {home}",
              "away_team": away,
              "home_team": home,
              "source": "Blue Chip Analytics",
              "updated_at": now_iso(),
            },
          )
          game["market_line"] = market_line
          game["market_team"] = market_team
          game["model_line"] = power_line
          game["model_team"] = model_team
          game["market_spread"] = market_spread
          game["model_spread"] = model_spread
          game["gap"] = round((market_spread or 0) - (model_spread or 0), 1) if market_spread is not None and model_spread is not None else None
          game["market_total"] = dollars_to_float(total)

  BLUECHIP_CACHE["expires_at"] = now + BLUECHIP_CACHE_SECONDS
  BLUECHIP_CACHE["games"] = games
  return games




def weather_impact(bluechip: dict[str, Any] | None, baseline_total: float | None = None) -> dict[str, Any] | None:
  if not bluechip:
    return None
  weather = bluechip.get("weather") or {}
  wind = weather.get("wind_mph")
  temp = weather.get("temperature_f")
  condition = (weather.get("condition") or "").lower()

  if wind is None and temp is None and not condition:
    return None

  wind_imp = 0.0
  if wind is not None:
    if wind >= 20:
      wind_imp = round((wind - 15) * 0.35, 1)
    elif wind >= 12:
      wind_imp = round((wind - 10) * 0.2, 1)

  precip_imp = 0.0
  if "rain" in condition or "shower" in condition:
    precip_imp = 1.5
  elif "snow" in condition:
    precip_imp = 2.5

  temp_imp = 0.0
  if temp is not None and temp <= 32:
    temp_imp = round((35 - temp) * 0.05, 1)

  total_adj = round(-(wind_imp + precip_imp + temp_imp), 1)
  spread_adj = round(wind_imp * 0.15 + precip_imp * 0.2, 1)

  score = int(clamp((wind_imp * 12 + precip_imp * 20 + temp_imp * 10), 0, 100))
  category = "Extreme" if score >= 65 else "Moderate" if score >= 35 else "Minor" if score >= 15 else "Negligible"

  adj_total = round(baseline_total + total_adj, 1) if baseline_total is not None else None

  return {
    "score": score,
    "category": category,
    "wind_impact": wind_imp,
    "precipitation_impact": precip_imp,
    "temperature_impact": temp_imp,
    "spread_adjustment": spread_adj,
    "total_adjustment": total_adj,
    "adjusted_total": adj_total,
    "adjusted_spread": spread_adj,
    "confidence": round(clamp(0.6 + score / 200.0, 0.6, 0.92), 2),
    "assumptions": {
      "rain_pct": 70 if "rain" in condition else 0,
      "snow_in": 2.0 if "snow" in condition else 0.0,
      "gust_mph": round((wind or 0) * 1.35, 1),
    },
  }


def board_row_is_modeled(row: dict[str, Any]) -> bool:
  rating = row.get("rating") or {}
  metrics = row.get("metrics") or {}
  return metrics.get("model_market_gap") is not None and rating.get("summary") != "Unmodeled market"


def collapse_board_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
  groups: dict[str, list[dict[str, Any]]] = {}
  for row in rows:
    if row.get("sport") in {"FINANCIALS", "ECONOMICS", "POLITICS", "TECH", "CULTURE"}:
      key = row.get("game_id", "")
    else:
      key = matchup_key(row["away_team"], row["home_team"])
    groups.setdefault(key or row.get("game_id", ""), []).append(row)

  collapsed: list[dict[str, Any]] = []
  for key, items in groups.items():
    primary = max(
      items,
      key=lambda item: (
        1 if board_row_is_modeled(item) else 0,
        item.get("edge_score") or 0,
        item.get("contract", {}).get("volume_24h") or 0,
      ),
    )
    alternate_markets = []
    for item in items:
      if item["game_id"] == primary["game_id"]:
        continue
      contract = item.get("contract") or {}
      rating = item.get("rating") or {}
      alternate_markets.append({
        "ticker": contract.get("ticker") or item["game_id"],
        "title": contract.get("title") or item.get("matchup"),
        "side_label": contract.get("side_label") or item.get("bet_side"),
        "bet_type": item.get("bet_type", "spread"),
        "line": item.get("market", {}).get("consensus_spread"),
        "yes_bid": contract.get("yes_bid"),
        "yes_ask": contract.get("yes_ask"),
        "last_price": contract.get("last_price"),
        "volume_24h": contract.get("volume_24h"),
        "model_gap": item.get("metrics", {}).get("model_market_gap"),
        "rating": rating.get("grade", "Even"),
        "summary": rating.get("summary", ""),
      })
    cloned = dict(primary)
    cloned["alternate_markets"] = alternate_markets
    collapsed.append(cloned)

  return sorted(
    collapsed,
    key=lambda row: (
      1 if board_row_is_modeled(row) else 0,
      row.get("edge_score") or 0,
      row.get("contract", {}).get("volume_24h") or 0,
    ),
    reverse=True,
  )


PRIMARY_CAT_MAP = {
  "Sports": "SPORTS",
  "American Football": "SPORTS",
  "Basketball": "SPORTS",
  "Baseball": "SPORTS",
  "Financials": "FINANCIALS",
  "Crypto": "FINANCIALS",
  "Commodities": "FINANCIALS",
  "Companies": "FINANCIALS",
  "Economics": "ECONOMICS",
  "Politics": "POLITICS",
  "Elections": "POLITICS",
  "World": "POLITICS",
  "Science and Technology": "TECH",
  "AI": "TECH",
  "Climate and Weather": "TECH",
  "Transportation": "TECH",
  "Health": "TECH",
  "Entertainment": "CULTURE",
  "Mentions": "CULTURE",
  "Social": "CULTURE",
}


async def fetch_kalshi_board() -> tuple[list[dict[str, Any]], str]:
  bluechip_games = await fetch_bluechip_analytics()
  raw_count = 0
  board: list[dict[str, Any]] = []
  seen_tickers: set[str] = set()
  captured_at = now_iso()

  async with httpx.AsyncClient(timeout=15.0) as client:
    # 1. Fetch targeted Sports spread series for BlueChip model matching
    for (sport_name, bet_type), series in KALSHI_MARKET_SERIES.items():
      url = f"{KALSHI_API_URL}/markets"
      params = {"series_ticker": series, "limit": 100, "status": "open"}
      resp = await client.get(url, params=params)
      if resp.status_code != 200:
        continue

      markets = resp.json().get("markets", [])
      raw_count += len(markets)

      for market in markets:
        ticker = market.get("ticker", "")
        if not ticker or ticker in seen_tickers:
          continue
        seen_tickers.add(ticker)

        yes_bid = kalshi_price_cents(market, "yes_bid", "yes_bid_dollars", "yes_bid_fp")
        yes_ask = kalshi_price_cents(market, "yes_ask", "yes_ask_dollars", "yes_ask_fp")
        no_bid = kalshi_price_cents(market, "no_bid", "no_bid_dollars", "no_bid_fp")
        no_ask = kalshi_price_cents(market, "no_ask", "no_ask_dollars", "no_ask_fp")
        last_price = kalshi_price_cents(market, "last_price", "last_price_dollars", "last_price_fp")
        previous_price = kalshi_price_cents(market, "previous_price", "previous_price_dollars", "previous_price_fp")

        away_team, home_team = extract_matchup(market)
        b_key = matchup_key(away_team, home_team)
        bluechip = bluechip_games.get(b_key)

        if not bluechip and not KALSHI_INCLUDE_UNMODELED:
          continue

        price_move = None
        if last_price is not None and previous_price is not None and previous_price > 0:
          price_move = round((last_price - previous_price) * 100, 1)

        cover_price = yes_bid if yes_bid is not None else last_price
        baseline_total = dollars_to_float(market.get("floor_strike")) if bet_type == "total" else None
        impact = weather_impact(bluechip, baseline_total)
        model_gap = contract_model_gap(bet_type, market, bluechip, impact)
        rating = rating_for_market(bet_type, market, bluechip, impact, model_gap, cover_price)
        weather_score = impact.get("score", 0) if impact else 0
        positive_gap = max(model_gap or 0, 0) if bet_type != "moneyline" else 0
        positive_edge = max(rating.get("edge") or 0, 0)
        edge_score = 0 if rating.get("grade") == "Even" else round(positive_gap * 10 + positive_edge * 10 + weather_score / 10, 2)

        is_arb = bool(yes_ask is not None and no_ask is not None and yes_ask > 0 and no_ask > 0 and (yes_ask + no_ask) <= 98.0)
        kickoff_time = market.get("occurrence_datetime") or market.get("open_time") or market.get("expected_expiration_time")
        close_time = market.get("close_time") or market.get("expiration_time")
        resolution_time = market.get("expected_expiration_time") or market.get("expiration_time")
        is_started = bool(kickoff_time and kickoff_time < captured_at)
        kalshi_url = f"https://kalshi.com/markets/{ticker}"

        board.append(
          {
            "game_id": ticker,
            "data_source": "kalshi",
            "sport": sport_name,
            "category": "SPORTS",
            "bet_type": bet_type,
            "edge_score": edge_score,
            "is_arb": is_arb,
            "is_started": is_started,
            "commence_time": kickoff_time,
            "close_time": close_time,
            "resolution_time": resolution_time,
            "kalshi_url": kalshi_url,
            "away_team": away_team,
            "home_team": home_team,
            "market": {
              "consensus_spread": market.get("floor_strike"),
              "best_favorite_line": yes_bid,
              "best_underdog_line": yes_ask,
              "opening_spread": previous_price,
              "book_count": 1,
              "latest_book": "Kalshi",
              "latest_timestamp": market.get("updated_time") or captured_at,
            },
            "contract": {
              "ticker": ticker,
              "title": (market.get("title") or "").replace("?", ""),
              "side_label": market.get("yes_sub_title") or market.get("title"),
              "yes_bid": yes_bid,
              "yes_ask": yes_ask,
              "no_bid": no_bid,
              "no_ask": no_ask,
              "last_price": last_price,
              "previous_price": previous_price,
              "price_move": price_move,
              "volume": fp_to_float(market.get("volume_fp")),
              "volume_24h": fp_to_float(market.get("volume_24h_fp")),
              "open_interest": fp_to_float(market.get("open_interest_fp")),
              "status": market.get("status"),
            },
            "model": {
              "fair_spread": bluechip.get("model_spread") if bluechip else None,
              "source": bluechip.get("source") if bluechip else None,
              "updated_at": bluechip.get("updated_at") if bluechip else None,
            },
            "bluechip": bluechip,
            "weather_impact": impact,
            "rating": rating,
            "metrics": {
              "model_market_gap": model_gap,
              "line_move": price_move,
              "confidence_score": gap_confidence(model_gap),
            },
            "updated_at": market.get("updated_time") or captured_at,
          }
        )

    # 2. Concurrently fetch open events across ALL Kalshi categories (Financials, Macro, Politics, Tech, Culture)
    try:
      resp_events = await client.get(f"{KALSHI_API_URL}/events", params={"status": "open", "limit": 120})
      if resp_events.status_code == 200:
        events = resp_events.json().get("events", [])
        sem = asyncio.Semaphore(12)

        async def fetch_event_m(ev: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
          async with sem:
            try:
              r = await client.get(f"{KALSHI_API_URL}/markets", params={"event_ticker": ev["event_ticker"]})
              if r.status_code == 200:
                return ev, r.json().get("markets", [])
            except Exception:
              pass
            return ev, []

        event_results = await asyncio.gather(*[fetch_event_m(ev) for ev in events])

        for ev, markets in event_results:
          raw_cat = ev.get("category") or "General"
          cat = PRIMARY_CAT_MAP.get(raw_cat, "POLITICS" if "Elections" in raw_cat else "TECH")

          for market in markets:
            ticker = market.get("ticker", "")
            if not ticker or ticker in seen_tickers:
              continue
            seen_tickers.add(ticker)
            raw_count += 1

            yes_bid = kalshi_price_cents(market, "yes_bid", "yes_bid_dollars", "yes_bid_fp")
            yes_ask = kalshi_price_cents(market, "yes_ask", "yes_ask_dollars", "yes_ask_fp")
            no_bid = kalshi_price_cents(market, "no_bid", "no_bid_dollars", "no_bid_fp")
            no_ask = kalshi_price_cents(market, "no_ask", "no_ask_dollars", "no_ask_fp")
            last_price = kalshi_price_cents(market, "last_price", "last_price_dollars", "last_price_fp")
            previous_price = kalshi_price_cents(market, "previous_price", "previous_price_dollars", "previous_price_fp")

            price_move = None
            if last_price is not None and previous_price is not None and previous_price > 0:
              price_move = round(last_price - previous_price, 1)

            volume = fp_to_float(market.get("volume_fp"))
            volume_24h = fp_to_float(market.get("volume_24h_fp"))
            open_interest = fp_to_float(market.get("open_interest_fp"))

            is_arb = bool(yes_ask is not None and no_ask is not None and yes_ask > 0 and no_ask > 0 and (yes_ask + no_ask) <= 98.0)
            kickoff_time = market.get("open_time") or market.get("expected_expiration_time") or captured_at
            close_time = market.get("close_time") or market.get("expiration_time")
            resolution_time = market.get("expected_expiration_time") or market.get("expiration_time")
            is_started = bool(kickoff_time and kickoff_time < captured_at)
            kalshi_url = f"https://kalshi.com/markets/{ticker}"

            title = (market.get("title") or ev.get("title") or "").replace("?", "")
            side_label = market.get("yes_sub_title") or market.get("title") or title

            edge_score = 40.0
            if is_arb:
              edge_score = round(150.0 + (98.0 - (yes_ask + no_ask)) * 5, 2)
            elif volume > 5000:
              edge_score = round(80.0 + min(volume / 1000, 40), 2)
            elif price_move and abs(price_move) > 5:
              edge_score = round(70.0 + min(abs(price_move) * 2, 40), 2)

            board.append(
              {
                "game_id": ticker,
                "data_source": "kalshi",
                "sport": cat,
                "category": cat,
                "raw_category": raw_cat,
                "bet_type": "binary_outcome",
                "edge_score": edge_score,
                "is_arb": is_arb,
                "is_started": is_started,
                "commence_time": kickoff_time,
                "close_time": close_time,
                "resolution_time": resolution_time,
                "kalshi_url": kalshi_url,
                "away_team": title,
                "home_team": raw_cat,
                "market": {
                  "consensus_spread": None,
                  "best_favorite_line": yes_bid,
                  "best_underdog_line": yes_ask,
                  "opening_spread": previous_price,
                  "book_count": 1,
                  "latest_book": "Kalshi",
                  "latest_timestamp": market.get("updated_time") or captured_at,
                },
                "contract": {
                  "ticker": ticker,
                  "title": title,
                  "side_label": side_label,
                  "yes_bid": yes_bid,
                  "yes_ask": yes_ask,
                  "no_bid": no_bid,
                  "no_ask": no_ask,
                  "last_price": last_price,
                  "previous_price": previous_price,
                  "price_move": price_move,
                  "volume": volume,
                  "volume_24h": volume_24h,
                  "open_interest": open_interest,
                  "status": market.get("status"),
                },
                "model": {"fair_spread": None, "source": None, "updated_at": None},
                "bluechip": None,
                "weather_impact": None,
                "rating": {
                  "grade": "Arbitrage" if is_arb else "Market",
                  "summary": f"Risk-Free Orderbook Arb (Ask {yes_ask}c + {no_ask}c)" if is_arb else f"Kalshi {raw_cat} Market",
                  "edge": edge_score,
                },
                "metrics": {
                  "model_market_gap": None,
                  "line_move": price_move,
                  "confidence_score": 95 if is_arb else 60,
                },
                "updated_at": market.get("updated_time") or captured_at,
              }
            )
    except Exception as e:
      logger.warning("Error fetching multi-category Kalshi events: %s", e)

  ranked_rows = collapse_board_rows(board)
  return (
    ranked_rows,
    f"Fetched {raw_count} Kalshi contracts across Sports, Finance, Macro, Politics & Tech; {len(ranked_rows)} active lines ready",
  )


def market_prompt_line(row: dict[str, Any], rank: int) -> str:
  rating = row.get("rating") or {}
  metrics = row.get("metrics") or {}
  market = row.get("market") or {}
  contract = row.get("contract") or {}
  gap = metrics.get("model_market_gap")
  model = row.get("bluechip", {}).get("model_line") if row.get("bluechip") else row.get("model", {}).get("fair_spread")
  price = contract.get("last_price") or contract.get("yes_bid") or contract.get("yes_ask")
  rating_label = "unrated" if rating.get("summary") == "Unmodeled market" or gap is None else rating.get("grade", "modeled")
  return (
    f"{rank}. {row.get('away_team')} at {row.get('home_team')} "
    f"({row.get('sport')}/{row.get('bet_type', 'spread')}) | "
    f"line={contract.get('side_label') or market.get('consensus_spread')} | "
    f"model={model} | gap={gap} | price={price} | read={rating_label}"
  )


def recent_thought_prompt_lines(limit: int = 8) -> list[str]:
  with connect() as conn:
    rows = conn.execute(
      """
      SELECT matchup, thought, confidence, edge, bet_placed, created_at
      FROM agent_thoughts
      ORDER BY id DESC
      LIMIT ?
      """,
      (limit,),
    ).fetchall()
  lines = []
  for row in rows:
    lines.append(
      f"{row['created_at']} | {row['matchup']} | edge={row['edge']} | confidence={row['confidence']} | bet_placed={row['bet_placed']} | {row['thought']}"
    )
  return lines


def recent_chat_prompt_lines(channel: str, chat_id: str, limit: int = 6) -> list[str]:
  with connect() as conn:
    rows = conn.execute(
      """
      SELECT user_name, user_message, assistant_message, created_at
      FROM agent_chat_messages
      WHERE channel = ? AND chat_id = ?
      ORDER BY id DESC
      LIMIT ?
      """,
      (channel, chat_id, limit),
    ).fetchall()
  return [
    f"{row['created_at']} | {row['user_name']}: {row['user_message']} | LineEdge: {row['assistant_message']}"
    for row in reversed(rows)
  ]


async def build_agent_chat_context(channel: str, chat_id: str) -> dict[str, Any]:
  board_data = await board()
  rows = board_data.get("rows", [])
  modeled_rows = [
    row for row in rows
    if row.get("metrics", {}).get("model_market_gap") is not None
      and (row.get("rating") or {}).get("summary") != "Unmodeled market"
  ]
  top_rows = modeled_rows[:8] or rows[:8]
  token_stats = get_token_stats()
  bets = get_agent_bets(limit=8).get("bets", [])

  token_status = (
    f"Token enabled: {token_stats.get('token_symbol')} CA {token_stats.get('contract_address')}"
    if token_stats.get("enabled")
    else "Token contract is not configured. Bankroll, burns, payouts, and steering are disabled/read-only."
  )

  return {
    "board_status": board_data.get("status"),
    "generated_at": board_data.get("generated_at"),
    "market_lines": [market_prompt_line(row, index + 1) for index, row in enumerate(top_rows)],
    "recent_thoughts": recent_thought_prompt_lines(),
    "recent_chat": recent_chat_prompt_lines(channel, chat_id),
    "token_status": token_status,
    "bet_count": len(bets),
    "execution_enabled": bool(token_stats.get("enabled")),
  }


def agent_system_prompt(context: dict[str, Any]) -> str:
  market_context = "\n".join(context["market_lines"]) or "No current board rows."
  thought_context = "\n".join(context["recent_thoughts"]) or "No recent agent thoughts yet."
  chat_context = "\n".join(context["recent_chat"]) or "No recent chat history."
  execution_rule = (
    "Execution is enabled only through the autonomous backend loop and configured token ledger."
    if context["execution_enabled"]
    else "Execution is disabled because no token CA exists. Do not claim there is bankroll, steering, burns, payouts, or real bets."
  )
  return f"""
You are LineEdge, the same sports-market agent whose read loop powers coveragedesk.online and Telegram.
You are not a separate Telegram bot. Speak as the shared LineEdge agent watching the board.

Operating rules:
- Use the live context below. Do not invent balances, contract addresses, bets, burns, payouts, model data, or weather.
- Distinguish modeled markets from unmodeled markets. If there is no model benchmark, say it is unrated.
- Users cannot manually trigger betting decisions. The backend read loop runs automatically on schedule.
- {execution_rule}
- Keep Telegram replies concise, useful, and direct. Plain text only.
- This is sports-market analysis, not financial advice.

Board generated at: {context["generated_at"]}
Board status: {context["board_status"]}
Token/protocol state: {context["token_status"]}

Top current board rows:
{market_context}

Recent LineEdge agent thoughts:
{thought_context}

Recent chat with this Telegram thread:
{chat_context}
""".strip()


async def call_opencode_chat(user_message: str, context: dict[str, Any]) -> tuple[str, str]:
  if not OPENCODE_API_KEY:
    return fallback_agent_chat(user_message, context), "fallback"

  payload = {
    "model": OPENCODE_CHAT_MODEL,
    "temperature": OPENCODE_CHAT_TEMPERATURE,
    "messages": [
      {"role": "system", "content": agent_system_prompt(context)},
      {"role": "user", "content": user_message},
    ],
  }
  headers = {
    "Authorization": f"Bearer {OPENCODE_API_KEY}",
    "Content-Type": "application/json",
  }
  async with httpx.AsyncClient(timeout=45.0) as client:
    response = await client.post(f"{OPENCODE_API_BASE_URL}/chat/completions", headers=headers, json=payload)
    response.raise_for_status()
    data = response.json()
  content = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
  if not content:
    content = fallback_agent_chat(user_message, context)
  return content[:3500], OPENCODE_CHAT_MODEL


def fallback_agent_chat(user_message: str, context: dict[str, Any]) -> str:
  lines = context.get("market_lines") or []
  top = lines[0] if lines else "No current board rows."
  prefix = "I am in read-only mode until the token CA is configured. " if not context.get("execution_enabled") else ""
  return (
    f"{prefix}Current top board read:\n{top}\n\n"
    "Ask me about a matchup, model gaps, latest agent thoughts, or why a row is unrated. "
    "The autonomous read loop handles decisions on schedule; there is no manual trigger in chat or on the site."
  )


def store_agent_chat(channel: str, chat_id: str, user_name: str, user_message: str, assistant_message: str, model: str) -> None:
  with connect() as conn:
    conn.execute(
      """
      INSERT INTO agent_chat_messages (channel, chat_id, user_name, user_message, assistant_message, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      """,
      (channel, chat_id, user_name, user_message, assistant_message, model, now_iso()),
    )
    conn.commit()


@app.get("/api/health")
def health() -> dict[str, Any]:
  return {
    "ok": True,
    "generated_at": now_iso(),
    "odds_api_configured": bool(os.getenv("ODDS_API_KEY")),
    "kalshi_public_data": True,
  }


@app.get("/api/board")
async def board() -> dict[str, Any]:
  status = "Using stored snapshots"

  try:
    rows, status = await fetch_kalshi_board()
    source = "kalshi"
  except Exception as exc:
    status = f"Kalshi refresh failed: {exc}"
    source = "live"
    rows = []

  # Attach per-game steering weights and thoughts to each board row
  conn = connect()
  cursor = conn.cursor()

  for row in rows:
    game_id = row.get("game_id")
    if COVERAGEDESK_TOKEN_CA:
      cursor.execute("SELECT holder_address, burned_tokens, underdog_bias, ncaaf_weight, nfl_weight, min_edge_threshold, custom_directive, created_at FROM steering_events WHERE game_id = ? ORDER BY id DESC LIMIT 1", (game_id,))
      steer = cursor.fetchone()
      row["steering"] = dict(steer) if steer else None
    else:
      row["steering"] = None

    cursor.execute("SELECT id, thought, confidence, edge, bet_placed, created_at FROM agent_thoughts WHERE game_id = ? ORDER BY id DESC LIMIT 3", (game_id,))
    thoughts = [dict(r) for r in cursor.fetchall()]
    row["agent_thoughts"] = thoughts

  return {
    "generated_at": now_iso(),
    "source": source,
    "status": status,
    "rows": rows,
  }


@app.get("/api/agent/thoughts")
def get_agent_thoughts(game_id: str | None = None, limit: int = 50) -> dict[str, Any]:
  conn = connect()
  cursor = conn.cursor()
  if game_id:
    cursor.execute(
      "SELECT id, game_id, matchup, thought, confidence, edge, bet_placed, steering_influences, created_at FROM agent_thoughts WHERE game_id = ? ORDER BY id DESC LIMIT ?",
      (game_id, limit),
    )
  else:
    cursor.execute(
      "SELECT id, game_id, matchup, thought, confidence, edge, bet_placed, steering_influences, created_at FROM agent_thoughts ORDER BY id DESC LIMIT ?",
      (limit,),
    )
  thoughts = [dict(row) for row in cursor.fetchall()]
  return {"thoughts": thoughts, "count": len(thoughts)}


@app.get("/api/agent/bets")
def get_agent_bets(limit: int = 50) -> dict[str, Any]:
  if not COVERAGEDESK_TOKEN_CA:
    return {"enabled": False, "bets": [], "count": 0}
  conn = connect()
  cursor = conn.cursor()
  cursor.execute(
    "SELECT id, game_id, matchup, sport, bet_side, line, odds, stake, status, payout, buyback_burned, dividend_distributed, created_at, resolved_at FROM agent_bets ORDER BY created_at DESC LIMIT ?",
    (limit,),
  )
  bets = [dict(row) for row in cursor.fetchall()]
  return {"bets": bets, "count": len(bets)}


@app.get("/api/agent/token-stats")
def get_token_stats() -> dict[str, Any]:
  if not COVERAGEDESK_TOKEN_CA:
    return {
      "enabled": False,
      "contract_address": None,
      "token_symbol": None,
      "message": "Token contract address is not configured",
    }
  conn = connect()
  cursor = conn.cursor()
  cursor.execute(
    "SELECT total_supply, bankroll_balance, total_fees_collected, total_burned, total_distributed, total_wins, total_losses, win_rate, updated_at FROM token_stats WHERE id = 1"
  )
  row = cursor.fetchone()
  if not row:
    return {
      "enabled": True,
      "contract_address": COVERAGEDESK_TOKEN_CA,
      "token_symbol": COVERAGEDESK_TOKEN_SYMBOL,
      "total_supply": 0.0,
      "bankroll_balance": 0.0,
      "total_fees_collected": 0.0,
      "total_burned": 0.0,
      "total_distributed": 0.0,
      "total_wins": 0,
      "total_losses": 0,
      "win_rate": 0.0,
      "updated_at": now_iso(),
    }
  return {
    "enabled": True,
    "contract_address": COVERAGEDESK_TOKEN_CA,
    "token_symbol": COVERAGEDESK_TOKEN_SYMBOL,
    **dict(row),
  }


@app.get("/api/agent/holders")
def get_holders() -> dict[str, Any]:
  if not COVERAGEDESK_TOKEN_CA:
    return {"enabled": False, "contract_address": None, "holders": []}
  conn = connect()
  cursor = conn.cursor()
  cursor.execute("SELECT address, balance, percentage, is_dividend_eligible, is_steering_eligible, updated_at FROM holder_ledger ORDER BY percentage DESC")
  holders = [dict(row) for row in cursor.fetchall()]
  return {"enabled": True, "contract_address": COVERAGEDESK_TOKEN_CA, "holders": holders}


@app.post("/api/agent/steer-game")
def submit_game_steering(payload: dict[str, Any]) -> dict[str, Any]:
  if not COVERAGEDESK_TOKEN_CA:
    raise HTTPException(status_code=503, detail="Token contract address is not configured")

  game_id = payload.get("game_id", "").strip()
  holder_address = payload.get("holder_address", "").strip()
  burned_tokens = float(payload.get("burned_tokens", 0.0))
  underdog_bias = float(payload.get("underdog_bias", 1.0))
  ncaaf_weight = float(payload.get("ncaaf_weight", 1.0))
  nfl_weight = float(payload.get("nfl_weight", 1.0))
  min_edge_threshold = float(payload.get("min_edge_threshold", 1.5))
  custom_directive = payload.get("custom_directive", "").strip()

  if not game_id or not holder_address:
    raise HTTPException(status_code=400, detail="game_id and holder_address are required")

  if burned_tokens < 10000:
    raise HTTPException(status_code=400, detail="Minimum steering burn is 10,000 $CVR")

  conn = connect()
  cursor = conn.cursor()
  cursor.execute("SELECT percentage, balance FROM holder_ledger WHERE address = ?", (holder_address,))
  holder = cursor.fetchone()

  if not holder:
    raise HTTPException(status_code=403, detail="Holder is not present in the token ledger")

  percentage = holder["percentage"]
  if percentage < 0.50:
    raise HTTPException(status_code=403, detail="Line steering requires holding ≥ 0.5% of total supply (5,000,000 $CVR)")

  conn.execute(
    """
    INSERT INTO steering_events (game_id, holder_address, burned_tokens, underdog_bias, ncaaf_weight, nfl_weight, min_edge_threshold, custom_directive, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """,
    (game_id, holder_address, burned_tokens, underdog_bias, ncaaf_weight, nfl_weight, min_edge_threshold, custom_directive, now_iso())
  )

  # Update total burned in token stats
  conn.execute("UPDATE token_stats SET total_burned = total_burned + ?, updated_at = ? WHERE id = 1", (burned_tokens, now_iso()))
  conn.commit()

  return {"ok": True, "message": f"Successfully burned {burned_tokens:,.0f} $CVR to steer line {game_id}!", "burned_tokens": burned_tokens}


@app.post("/api/agent/chat")
async def agent_chat(payload: dict[str, Any]) -> dict[str, Any]:
  message = (payload.get("message") or "").strip()
  channel = (payload.get("channel") or "web").strip()[:40]
  chat_id = str(payload.get("chat_id") or "default").strip()[:120]
  user_name = (payload.get("user_name") or "user").strip()[:120]

  if not message:
    raise HTTPException(status_code=400, detail="message is required")

  context = await build_agent_chat_context(channel, chat_id)
  try:
    reply, model = await call_opencode_chat(message, context)
  except Exception as exc:
    reply = f"I could not reach the OpenCode model right now. {fallback_agent_chat(message, context)}"
    model = f"fallback:{type(exc).__name__}"

  store_agent_chat(channel, chat_id, user_name, message, reply, model)
  return {
    "ok": True,
    "reply": reply,
    "model": model,
    "execution_enabled": context["execution_enabled"],
    "generated_at": now_iso(),
  }


@app.post("/api/agent/tick")
async def agent_tick() -> dict[str, Any]:
  board_data = await board()
  rows = board_data.get("rows", [])

  conn = connect()
  cursor = conn.cursor()
  new_thoughts = []
  new_bets = []

  for row in rows[:8]:
    steering = row.get("steering") or {
      "underdog_bias": 1.0, "ncaaf_weight": 1.0, "nfl_weight": 1.0, "min_edge_threshold": 1.5, "custom_directive": ""
    }
    steering["execution_enabled"] = bool(COVERAGEDESK_TOKEN_CA)
    thought, bet = agent_engine.generate_thought_and_bet(row, steering)
    conn.execute(
      """
      INSERT INTO agent_thoughts (game_id, matchup, thought, confidence, edge, bet_placed, steering_influences, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      """,
      (thought["game_id"], thought["matchup"], thought["thought"], thought["confidence"], thought["edge"], thought["bet_placed"], thought["steering_influences"], thought["created_at"])
    )
    new_thoughts.append(thought)

    if bet and COVERAGEDESK_TOKEN_CA:
      conn.execute(
        """
        INSERT OR IGNORE INTO agent_bets (id, game_id, matchup, sport, bet_side, line, odds, stake, status, payout, buyback_burned, dividend_distributed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (bet["id"], bet["game_id"], bet["matchup"], bet["sport"], bet["bet_side"], bet["line"], bet["odds"], bet["stake"], bet["status"], bet["payout"], bet["buyback_burned"], bet["dividend_distributed"], bet["created_at"])
      )
      new_bets.append(bet)

  open_bets = []
  if COVERAGEDESK_TOKEN_CA:
    cursor.execute("SELECT id, game_id, matchup, sport, bet_side, line, odds, stake, status, payout, buyback_burned, dividend_distributed, created_at, resolved_at FROM agent_bets WHERE status = 'OPEN'")
    open_bets = [dict(r) for r in cursor.fetchall()]

  total_burned_delta = 0.0
  total_distributed_delta = 0.0

  for open_bet in open_bets:
    settled = agent_engine.settle_bet_outcome(open_bet, result="WON")
    conn.execute(
      "UPDATE agent_bets SET status = ?, payout = ?, buyback_burned = ?, dividend_distributed = ?, resolved_at = ? WHERE id = ?",
      (settled["status"], settled["payout"], settled["buyback_burned"], settled["dividend_distributed"], settled["resolved_at"], settled["id"])
    )

    if settled["status"] == "WON":
      total_burned_delta += settled["buyback_burned"]
      total_distributed_delta += settled["dividend_distributed"]

      conn.execute(
        "INSERT INTO burn_and_payout_history (bet_id, event_type, amount, recipients_count, tx_hash, timestamp) VALUES (?, 'BUYBACK_BURN', ?, 1, ?, ?)",
        (settled["id"], settled["buyback_burned"], f"0xburn_{settled['id']}", now_iso())
      )
      cursor.execute("SELECT COUNT(*) FROM holder_ledger WHERE is_dividend_eligible = 1")
      eligible_count = cursor.fetchone()[0]
      conn.execute(
        "INSERT INTO burn_and_payout_history (bet_id, event_type, amount, recipients_count, tx_hash, timestamp) VALUES (?, 'DIVIDEND_PAYOUT', ?, ?, ?, ?)",
        (settled["id"], settled["dividend_distributed"], eligible_count, f"0xpayout_{settled['id']}", now_iso())
      )

  if COVERAGEDESK_TOKEN_CA:
    conn.execute(
      """
      UPDATE token_stats
      SET total_burned = total_burned + ?,
          total_distributed = total_distributed + ?,
          total_wins = total_wins + ?,
          updated_at = ?
      WHERE id = 1
      """,
      (total_burned_delta, total_distributed_delta, len(open_bets), now_iso())
    )

  conn.commit()
  return {
    "ok": True,
    "processed_thoughts": len(new_thoughts),
    "placed_bets": len(new_bets),
    "settled_bets": len(open_bets),
    "buyback_burned_tokens": total_burned_delta,
    "distributed_dividend_tokens": total_distributed_delta,
  }
