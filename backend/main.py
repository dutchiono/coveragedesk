import csv
import asyncio
import html
import json
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
  ("NCAAF", "spread"): "KXNCAAFSPREAD",
  ("NCAAF", "total"): "KXNCAAFTOTAL",
}
BLUECHIP_WEEK_URL = os.getenv("BLUECHIP_WEEK_URL", "https://bluechipanalytics.com/college-football/games/2026/week3/")
BLUECHIP_CACHE_SECONDS = int(os.getenv("BLUECHIP_CACHE_SECONDS", "1800"))
ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("COVERAGEDESK_DB", ROOT / "data" / "coveragedesk.sqlite3"))
PROJECTIONS_PATH = Path(os.getenv("COVERAGEDESK_PROJECTIONS", ROOT / "data" / "projections.csv"))

app = FastAPI(title="CoverageDesk API")
BLUECHIP_CACHE: dict[str, Any] = {"expires_at": 0.0, "games": {}}


def now_iso() -> str:
  return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_id(sport: str, commence_time: str, away_team: str, home_team: str) -> str:
  date = commence_time[:10].replace("-", "_")
  slug = "_".join([sport.lower(), date, slugify(away_team), slugify(home_team)])
  return slug


def slugify(value: str) -> str:
  return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def matchup_key(away_team: str, home_team: str) -> str:
  return "|".join(sorted([team_key(away_team), team_key(home_team)]))


def team_key(value: str) -> str:
  normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
  normalized = re.sub(r"\bst[.]?\b", "state", normalized, flags=re.I)
  normalized = normalized.replace("&", " and ")
  return slugify(normalized)


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

  # Seed token stats if empty
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
    return None


def fp_to_float(value: Any) -> float:
  parsed = dollars_to_float(value)
  return parsed if parsed is not None else 0


def clamp(value: float, minimum: float, maximum: float) -> float:
  return max(minimum, min(maximum, value))


def extract_matchup(market: dict[str, Any]) -> tuple[str, str]:
  rules = market.get("rules_primary") or ""
  match = re.search(r"in the (.+?) vs (.+?) (?:college football|Pro Football)", rules)
  if match:
    return match.group(1), match.group(2)
  title = (market.get("title") or "").replace("?", "")
  team = title.split(" wins", 1)[0] or market.get("yes_sub_title") or "Kalshi"
  return team, "Market"


def clean_text(value: str | None) -> str | None:
  if value is None:
    return None
  return html.unescape(value).replace("\ufffd", "°").strip()


def signed_line(team: str | None, spread: float | None) -> str | None:
  if not team or spread is None:
    return None
  return f"{team} {spread:+.1f}".replace("+", "")


def opponent_team(away_team: str, home_team: str, team: str | None) -> str | None:
  if not team:
    return None
  key = team_key(team)
  if key == team_key(away_team):
    return home_team
  if key == team_key(home_team):
    return away_team
  return None


def contract_side_team(market: dict[str, Any]) -> str | None:
  label = market.get("yes_sub_title") or market.get("title") or ""
  match = re.match(r"(.+?) wins\b", label.replace("?", ""), re.I)
  return clean_text(match.group(1)) if match else None


def contract_model_gap(bet_type: str, market: dict[str, Any], bluechip: dict[str, Any] | None, impact: dict[str, Any] | None) -> float | None:
  threshold = dollars_to_float(market.get("floor_strike"))
  if threshold is None:
    return None
  if bet_type == "spread" and bluechip:
    model_spread = bluechip.get("model_spread")
    model_team = bluechip.get("model_team")
    side_team = contract_side_team(market)
    if model_spread is None or not model_team or not side_team:
      return bluechip.get("gap")
    model_margin = abs(float(model_spread))
    side_margin = model_margin if team_key(side_team) == team_key(model_team) else -model_margin
    return round(side_margin - threshold, 1)
  if bet_type == "total" and impact and impact.get("adjusted_total") is not None:
    adjusted_total = float(impact["adjusted_total"])
    label = f"{market.get('yes_sub_title') or ''} {market.get('title') or ''}".lower()
    return round(threshold - adjusted_total, 1) if "under" in label else round(adjusted_total - threshold, 1)
  return None


def inferred_precipitation(condition: str | None) -> tuple[float, float]:
  text = (condition or "").lower()
  rain_pct = 0.0
  snow_in = 0.0
  if any(word in text for word in ["rain", "drizzle", "shower", "thunder"]):
    rain_pct = 60.0 if "patchy" in text or "nearby" in text else 80.0
  if "snow" in text or "sleet" in text or "blizzard" in text:
    snow_in = 1.0 if "light" in text or "patchy" in text else 2.0
  return rain_pct, snow_in


def weather_category(score: float) -> str:
  if score < 15:
    return "Minimal"
  if score < 30:
    return "Mild"
  if score < 50:
    return "Moderate"
  if score < 70:
    return "Severe"
  return "Extreme"


def weather_impact(bluechip: dict[str, Any] | None, baseline_total: float | None) -> dict[str, Any] | None:
  if not bluechip:
    return None
  weather = bluechip.get("weather") or {}
  condition = weather.get("condition")
  temp = dollars_to_float(weather.get("temperature_f"))
  wind = dollars_to_float(weather.get("wind_mph"))
  if temp is None and wind is None and not condition:
    return None

  temp_f = temp if temp is not None else 65.0
  wind_mph = max(wind if wind is not None else 0.0, 0.0)
  gust_mph = wind_mph
  rain_pct, snow_in = inferred_precipitation(condition)

  wind_component = clamp((wind_mph - 5) / 20, 0, 1) * 35
  gust_component = clamp((gust_mph - 10) / 30, 0, 1) * 15
  rain_component = clamp(rain_pct / 100, 0, 1) * 15
  snow_component = clamp(snow_in / 4, 0, 1) * 20
  cold_component = clamp((40 - temp_f) / 35, 0, 1) * 10
  score = round(clamp(wind_component + gust_component + rain_component + snow_component + cold_component, 0, 100), 1)

  total_adjustment = -(score / 100) * 8.0
  total_adjustment -= max(0, wind_mph - 12) * 0.10
  total_adjustment -= max(0, gust_mph - 25) * 0.04
  total_adjustment -= (rain_pct / 100) * 0.8
  total_adjustment -= min(snow_in, 4) * 0.35
  if temp_f < 25:
    total_adjustment -= 0.5

  adjusted_total = None if baseline_total is None else round(baseline_total + total_adjustment, 2)
  model_spread = bluechip.get("model_spread")
  adjusted_spread = None if model_spread is None else round(float(model_spread), 2)
  projected = None
  if adjusted_total is not None and adjusted_spread is not None:
    projected = {
      "team_a_points": round((adjusted_total + adjusted_spread) / 2, 2),
      "team_b_points": round((adjusted_total - adjusted_spread) / 2, 2),
    }

  return {
    "score": score,
    "category": weather_category(score),
    "wind_impact": round(wind_component + gust_component, 1),
    "precipitation_impact": round(rain_component + snow_component, 1),
    "temperature_impact": round(cold_component, 1),
    "spread_adjustment": 0.0,
    "total_adjustment": round(total_adjustment, 2),
    "adjusted_total": adjusted_total,
    "adjusted_spread": adjusted_spread,
    "projected_score": projected,
    "confidence": round(clamp(50 + score * 0.45, 50, 95), 1),
    "assumptions": {
      "rain_pct": rain_pct,
      "snow_in": snow_in,
      "gust_mph": gust_mph,
    },
  }


def gap_confidence(model_gap: float | None) -> int:
  if model_gap is None:
    return 46
  if model_gap >= 4:
    return 88
  if model_gap >= 2.5:
    return 76
  if model_gap >= 1:
    return 64
  return 52


def parse_bluechip_game(page: str, url: str) -> dict[str, Any] | None:
  title_match = re.search(r"<title>(.*?)\s+Prediction,", page, re.I | re.S)
  if not title_match:
    return None
  teams = clean_text(re.sub(r"\s+", " ", title_match.group(1))).split(" vs ")
  if len(teams) != 2:
    return None
  away_team, home_team = teams

  line_match = re.search(
    r"The market has (?P<market_team>.+?) (?P<market_spread>[+-]?\d+(?:\.\d+)?) and the Blue Chip model makes it (?P<model_team>.+?) (?P<model_spread>[+-]?\d+(?:\.\d+)?) - a gap of (?P<gap>\d+(?:\.\d+)?) points toward (?P<edge_team>.+?)(?:,|\.)",
    page,
    re.I | re.S,
  )
  weather_match = re.search(
    r"The forecast for (?P<venue>.+?) shows (?P<condition>.+?), (?P<temp>\d+(?:\.\d+)?)\s*[°\ufffd]F with winds of (?P<wind>\d+(?:\.\d+)?) mph",
    page,
    re.I | re.S,
  )
  desc_match = re.search(r'<meta name="description" content="([^"]+)"', page, re.I)
  image_match = re.search(r'<meta property="og:image"\s+content="([^"]+)"', page, re.I)
  modified_match = re.search(r'"dateModified":\s*"([^"]+)"', page, re.I)

  market_team = clean_text(line_match.group("market_team")) if line_match else None
  model_team = clean_text(line_match.group("model_team")) if line_match else None
  market_spread = float(line_match.group("market_spread")) if line_match else None
  model_spread = float(line_match.group("model_spread")) if line_match else None
  desc_text = clean_text(desc_match.group(1)) if desc_match else None

  if desc_text and (market_spread is None or model_spread is None):
    fallback = re.search(
      r"line (?P<market_team>.+?) (?P<market_spread>[+-]?\d+(?:\.\d+)?)\.\s+Power ratings favor (?P<model_team>.+?) by (?P<model_margin>\d+(?:\.\d+)?)",
      desc_text,
      re.I,
    )
    if fallback:
      market_team = clean_text(fallback.group("market_team"))
      market_spread = float(fallback.group("market_spread"))
      model_team = clean_text(fallback.group("model_team"))
      model_margin = float(fallback.group("model_margin"))
      market_opponent = opponent_team(away_team, home_team, market_team)
      model_spread = -model_margin if model_team == market_team else model_margin
      if market_spread and market_team and market_opponent and market_spread > 0:
        market_team = market_opponent
        market_spread = -market_spread

  gap = float(line_match.group("gap")) if line_match else None
  if gap is None and market_spread is not None and model_spread is not None:
    gap = round(abs(model_spread - market_spread), 1)

  return {
    "away_team": away_team,
    "home_team": home_team,
    "market_line": signed_line(market_team, market_spread),
    "model_line": signed_line(model_team, model_spread),
    "market_team": market_team,
    "model_team": model_team,
    "market_spread": market_spread,
    "model_spread": model_spread,
    "gap": gap,
    "edge_team": clean_text(line_match.group("edge_team")) if line_match else None,
    "summary": desc_text,
    "weather": {
      "venue": clean_text(weather_match.group("venue")) if weather_match else None,
      "condition": clean_text(weather_match.group("condition")) if weather_match else None,
      "temperature_f": float(weather_match.group("temp")) if weather_match else None,
      "wind_mph": float(weather_match.group("wind")) if weather_match else None,
      "source": "WeatherAPI.com",
      "map_url": clean_text(image_match.group(1)) if image_match else None,
    },
    "source": "Blue Chip Analytics",
    "url": url,
    "updated_at": clean_text(modified_match.group(1)) if modified_match else None,
  }


async def fetch_bluechip_games() -> dict[str, dict[str, Any]]:
  if not BLUECHIP_WEEK_URL:
    return {}
  now = time.time()
  if BLUECHIP_CACHE["expires_at"] > now:
    return BLUECHIP_CACHE["games"]

  async with httpx.AsyncClient(timeout=25, follow_redirects=True) as client:
    response = await client.get(BLUECHIP_WEEK_URL)
    response.raise_for_status()
    week_page = response.text
    urls = sorted(
      {
        url if url.startswith("http") else f"https://bluechipanalytics.com{url}"
        for url in re.findall(r'https://bluechipanalytics\.com/college-football/games/2026/week\d+/2026-[^"]+?/|href="(/college-football/games/2026/week\d+/2026-[^"]+?/)"', week_page)
        for url in ((url,) if isinstance(url, str) else url)
        if url
      }
    )
    if not urls:
      urls = sorted(set(re.findall(r"https://bluechipanalytics\.com/college-football/games/2026/week\d+/2026-[^\" ]+?/", week_page)))

    semaphore = asyncio.Semaphore(8)

    async def fetch_one(url: str) -> dict[str, Any] | None:
      async with semaphore:
        try:
          game_response = await client.get(url)
          game_response.raise_for_status()
          return parse_bluechip_game(game_response.text, url)
        except Exception:
          return None

    games = [game for game in await asyncio.gather(*(fetch_one(url) for url in urls)) if game]
    keyed = {matchup_key(game["away_team"], game["home_team"]): game for game in games}
    BLUECHIP_CACHE.update({"expires_at": now + BLUECHIP_CACHE_SECONDS, "games": keyed})
    return keyed


def load_projections() -> dict[str, dict[str, Any]]:
  if not PROJECTIONS_PATH.exists():
    return {}
  with PROJECTIONS_PATH.open(newline="", encoding="utf-8") as f:
    rows = csv.DictReader(f)
    return {
      row["game_id"]: {
        "fair_spread": float(row["fair_spread"]),
        "source": row.get("source") or "csv_projection",
        "updated_at": row.get("updated_at") or None,
      }
      for row in rows
      if row.get("game_id") and row.get("fair_spread")
    }


async def fetch_odds() -> tuple[list[dict[str, Any]], str]:
  api_key = os.getenv("ODDS_API_KEY")
  if not api_key:
    return [], "ODDS_API_KEY is not set on the backend"

  rows: list[dict[str, Any]] = []
  captured_at = now_iso()
  async with httpx.AsyncClient(timeout=25) as client:
    for sport_name, sport_key in SPORTS.items():
      response = await client.get(
        API_URL.format(sport=sport_key),
        params={
          "apiKey": api_key,
          "regions": os.getenv("ODDS_REGION", "us"),
          "markets": "spreads",
          "oddsFormat": "american",
        },
      )
      response.raise_for_status()
      for event in response.json():
        game_id = canonical_id(sport_name, event["commence_time"], event["away_team"], event["home_team"])
        for book in event.get("bookmakers", []):
          spread_market = next((market for market in book.get("markets", []) if market.get("key") == "spreads"), None)
          if not spread_market:
            continue
          for outcome in spread_market.get("outcomes", []):
            rows.append(
              {
                "game_id": game_id,
                "provider_event_id": event["id"],
                "sport": sport_name,
                "commence_time": event["commence_time"],
                "home_team": event["home_team"],
                "away_team": event["away_team"],
                "book": book["title"],
                "market": "spreads",
                "side": outcome["name"],
                "line": outcome.get("point"),
                "price": outcome.get("price"),
                "captured_at": captured_at,
              }
            )
  return rows, f"Fetched {len(rows)} sportsbook lines"


async def fetch_kalshi_board() -> tuple[list[dict[str, Any]], str]:
  limit = int(os.getenv("KALSHI_MARKET_LIMIT", "1000"))
  max_pages = int(os.getenv("KALSHI_MAX_PAGES", "10"))
  captured_at = now_iso()
  board: list[dict[str, Any]] = []
  bluechip_games = await fetch_bluechip_games()
  async with httpx.AsyncClient(timeout=25) as client:
    for (sport_name, bet_type), series_ticker in KALSHI_MARKET_SERIES.items():
      markets: list[dict[str, Any]] = []
      cursor = ""
      for _ in range(max_pages):
        params = {"series_ticker": series_ticker, "status": "open", "limit": limit}
        if cursor:
          params["cursor"] = cursor
        response = await client.get(f"{KALSHI_API_URL}/markets", params=params)
        response.raise_for_status()
        payload = response.json()
        markets.extend(payload.get("markets", []))
        cursor = payload.get("cursor") or ""
        if not cursor:
          break

      for market in markets:
        away_team, home_team = extract_matchup(market)
        bluechip = bluechip_games.get(matchup_key(away_team, home_team)) if sport_name == "NCAAF" else None
        yes_bid = dollars_to_float(market.get("yes_bid_dollars"))
        yes_ask = dollars_to_float(market.get("yes_ask_dollars"))
        no_bid = dollars_to_float(market.get("no_bid_dollars"))
        no_ask = dollars_to_float(market.get("no_ask_dollars"))
        last_price = dollars_to_float(market.get("last_price_dollars"))
        previous_price = dollars_to_float(market.get("previous_price_dollars"))
        price_move = None
        if last_price is not None and previous_price is not None and previous_price > 0:
          price_move = round((last_price - previous_price) * 100, 1)
        cover_price = yes_bid if yes_bid is not None else last_price
        baseline_total = dollars_to_float(market.get("floor_strike")) if bet_type == "total" else None
        impact = weather_impact(bluechip, baseline_total)
        model_gap = contract_model_gap(bet_type, market, bluechip, impact)
        weather_score = impact.get("score", 0) if impact else 0
        positive_gap = max(model_gap or 0, 0)
        price_score = (1 - (cover_price or 0.5)) * 20 if positive_gap else 0
        edge_score = round(positive_gap * 20 + price_score + weather_score / 10, 2)

        board.append(
          {
            "game_id": market["ticker"],
            "data_source": "kalshi",
            "sport": sport_name,
            "bet_type": bet_type,
            "edge_score": edge_score,
            "commence_time": market.get("occurrence_datetime") or market.get("expected_expiration_time"),
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
              "ticker": market["ticker"],
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
            "metrics": {
              "model_market_gap": model_gap,
              "line_move": price_move,
              "confidence_score": gap_confidence(model_gap),
            },
            "updated_at": market.get("updated_time") or captured_at,
          }
        )

  return sorted(
    board,
    key=lambda row: (
      row["edge_score"],
      row["metrics"]["model_market_gap"] or 0,
      abs(row["contract"]["price_move"] or 0),
    ),
    reverse=True,
  ), f"Fetched {len(board)} Kalshi football spread/total contracts"


def store_snapshots(rows: list[dict[str, Any]]) -> None:
  if not rows:
    return
  with connect() as conn:
    conn.executemany(
      """
      INSERT INTO odds_snapshots (
        game_id, provider_event_id, sport, commence_time, home_team, away_team,
        book, market, side, line, price, captured_at
      ) VALUES (
        :game_id, :provider_event_id, :sport, :commence_time, :home_team, :away_team,
        :book, :market, :side, :line, :price, :captured_at
      )
      """,
      rows,
    )
    conn.commit()


def current_snapshots() -> list[sqlite3.Row]:
  with connect() as conn:
    return conn.execute(
      """
      SELECT o.*
      FROM odds_snapshots o
      JOIN (
        SELECT game_id, book, side, MAX(captured_at) AS captured_at
        FROM odds_snapshots
        GROUP BY game_id, book, side
      ) latest
      ON o.game_id = latest.game_id
        AND o.book = latest.book
        AND o.side = latest.side
        AND o.captured_at = latest.captured_at
      ORDER BY o.commence_time
      """
    ).fetchall()


def opening_spread(conn: sqlite3.Connection, game_id: str, home_team: str) -> float | None:
  row = conn.execute(
    """
    SELECT line FROM odds_snapshots
    WHERE game_id = ? AND side = ?
    ORDER BY captured_at ASC, id ASC
    LIMIT 1
    """,
    (game_id, home_team),
  ).fetchone()
  return None if row is None else row["line"]


def build_board() -> list[dict[str, Any]]:
  projections = load_projections()
  snapshots = current_snapshots()
  grouped: dict[str, list[sqlite3.Row]] = {}
  for row in snapshots:
    grouped.setdefault(row["game_id"], []).append(row)

  board: list[dict[str, Any]] = []
  with connect() as conn:
    for game_id, rows in grouped.items():
      sample = rows[0]
      home_team = sample["home_team"]
      away_team = sample["away_team"]
      home_rows = [row for row in rows if row["side"] == home_team and row["line"] is not None]
      away_rows = [row for row in rows if row["side"] == away_team and row["line"] is not None]
      if not home_rows:
        continue

      consensus = statistics.median([row["line"] for row in home_rows])
      opener = opening_spread(conn, game_id, home_team)
      line_move = None if opener is None else consensus - opener
      latest = max(rows, key=lambda row: row["captured_at"])
      projection = projections.get(game_id, {})
      fair_spread = projection.get("fair_spread")
      gap = None if fair_spread is None else fair_spread - consensus
      home_favorite = consensus <= 0
      favorite_pool = home_rows if home_favorite else away_rows
      underdog_pool = away_rows if home_favorite else home_rows
      confidence = min(96, 54 + len({row["book"] for row in rows}) * 5 + (12 if fair_spread is not None else 0))

      board.append(
        {
          "game_id": game_id,
          "data_source": "sportsbook",
          "sport": sample["sport"],
          "commence_time": sample["commence_time"],
          "away_team": away_team,
          "home_team": home_team,
          "market": {
            "consensus_spread": consensus,
            "best_favorite_line": max([row["line"] for row in favorite_pool], default=None),
            "best_underdog_line": max([row["line"] for row in underdog_pool], default=None),
            "opening_spread": opener,
            "book_count": len({row["book"] for row in rows}),
            "latest_book": latest["book"],
            "latest_timestamp": latest["captured_at"],
          },
          "model": {
            "fair_spread": fair_spread,
            "source": projection.get("source"),
            "updated_at": projection.get("updated_at"),
          },
          "metrics": {
            "model_market_gap": gap,
            "line_move": line_move,
            "confidence_score": confidence,
          },
          "updated_at": latest["captured_at"],
        }
      )

  return sorted(
    board,
    key=lambda row: abs(row["metrics"]["model_market_gap"] or row["metrics"]["line_move"] or 0),
    reverse=True,
  )


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
    rows, status = await fetch_odds()
    store_snapshots(rows)
  except Exception as exc:
    status = f"Odds refresh failed; using stored snapshots: {exc}"

  rows = build_board()
  source = "sportsbook"
  if not rows:
    try:
      rows, status = await fetch_kalshi_board()
      source = "kalshi"
    except Exception as exc:
      status = f"Kalshi refresh failed and no sportsbook snapshots are stored: {exc}"
      source = "live"

  return {
    "generated_at": now_iso(),
    "source": source,
    "status": status,
    "rows": rows,
  }


@app.get("/api/agent/thoughts")
def get_agent_thoughts(limit: int = 50) -> dict[str, Any]:
  conn = connect()
  cursor = conn.cursor()
  cursor.execute(
    "SELECT id, game_id, matchup, thought, confidence, edge, bet_placed, steering_influences, created_at FROM agent_thoughts ORDER BY id DESC LIMIT ?",
    (limit,),
  )
  thoughts = [dict(row) for row in cursor.fetchall()]
  return {"thoughts": thoughts, "count": len(thoughts)}


@app.get("/api/agent/bets")
def get_agent_bets(limit: int = 50) -> dict[str, Any]:
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
  conn = connect()
  cursor = conn.cursor()
  cursor.execute(
    "SELECT total_supply, bankroll_balance, total_fees_collected, total_burned, total_distributed, total_wins, total_losses, win_rate, updated_at FROM token_stats WHERE id = 1"
  )
  row = cursor.fetchone()
  if not row:
    return {"total_supply": 1_000_000_000.0, "bankroll_balance": 50000.0, "total_fees_collected": 0.0, "total_burned": 0.0, "total_distributed": 0.0, "total_wins": 0, "total_losses": 0, "win_rate": 0.0, "updated_at": now_iso()}
  return dict(row)


@app.get("/api/agent/holders")
def get_holders() -> dict[str, Any]:
  conn = connect()
  cursor = conn.cursor()
  cursor.execute("SELECT address, balance, percentage, is_dividend_eligible, is_steering_eligible, updated_at FROM holder_ledger ORDER BY percentage DESC")
  holders = [dict(row) for row in cursor.fetchall()]
  return {"holders": holders}


@app.get("/api/agent/steering-status")
def get_steering_status() -> dict[str, Any]:
  conn = connect()
  cursor = conn.cursor()
  cursor.execute("SELECT holder_address, burned_tokens, underdog_bias, ncaaf_weight, nfl_weight, min_edge_threshold, custom_directive, created_at FROM steering_events ORDER BY id DESC LIMIT 1")
  latest = cursor.fetchone()
  if latest:
    return dict(latest)
  return {
    "underdog_bias": 1.0,
    "ncaaf_weight": 1.0,
    "nfl_weight": 1.0,
    "min_edge_threshold": 1.5,
    "custom_directive": "Default CoverageDesk Strategy (Consensus Gap > 1.5 pts)",
    "created_at": now_iso(),
    "burned_tokens": 0.0,
  }


@app.post("/api/agent/steer")
def submit_steering(payload: dict[str, Any]) -> dict[str, Any]:
  holder_address = payload.get("holder_address", "").strip()
  burned_tokens = float(payload.get("burned_tokens", 0.0))
  underdog_bias = float(payload.get("underdog_bias", 1.0))
  ncaaf_weight = float(payload.get("ncaaf_weight", 1.0))
  nfl_weight = float(payload.get("nfl_weight", 1.0))
  min_edge_threshold = float(payload.get("min_edge_threshold", 1.5))
  custom_directive = payload.get("custom_directive", "").strip()

  if not holder_address:
    raise HTTPException(status_code=400, detail="holder_address is required")

  conn = connect()
  cursor = conn.cursor()
  cursor.execute("SELECT percentage, balance FROM holder_ledger WHERE address = ?", (holder_address,))
  holder = cursor.fetchone()

  # Check if holder holds >= 0.5% (5,000,000 $COVERAGE) or mock verification
  percentage = holder["percentage"] if holder else 0.50
  if percentage < 0.50:
    raise HTTPException(status_code=403, detail="Steering requires holding >= 0.5% of total supply (5,000,000 $COVERAGE)")

  conn.execute(
    """
    INSERT INTO steering_events (holder_address, burned_tokens, underdog_bias, ncaaf_weight, nfl_weight, min_edge_threshold, custom_directive, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """,
    (holder_address, burned_tokens, underdog_bias, ncaaf_weight, nfl_weight, min_edge_threshold, custom_directive, now_iso())
  )

  # Update total burned in token stats
  conn.execute("UPDATE token_stats SET total_burned = total_burned + ?, updated_at = ? WHERE id = 1", (burned_tokens, now_iso()))
  conn.commit()

  return {"ok": True, "message": "Steering weights updated and tokens burned", "burned_tokens": burned_tokens}


@app.post("/api/agent/tick")
async def agent_tick() -> dict[str, Any]:
  """
  Trigger agent cycle:
  1. Reads active board lines.
  2. Reads active holder steering weights.
  3. Evaluates matchups, generates thoughts, places automated bets.
  4. Settles completed bets:
     - 50% net win profit -> Buy back and burn $COVERAGE.
     - 50% net win profit -> Distribute dividends to >1% holders.
  """
  board_data = await board()
  rows = board_data.get("rows", [])
  steering = get_steering_status()

  conn = connect()
  cursor = conn.cursor()
  new_thoughts = []
  new_bets = []

  for row in rows[:5]:  # Process top candidates
    thought, bet = agent_engine.generate_thought_and_bet(row, steering)
    conn.execute(
      """
      INSERT INTO agent_thoughts (game_id, matchup, thought, confidence, edge, bet_placed, steering_influences, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      """,
      (thought["game_id"], thought["matchup"], thought["thought"], thought["confidence"], thought["edge"], thought["bet_placed"], thought["steering_influences"], thought["created_at"])
    )
    new_thoughts.append(thought)

    if bet:
      conn.execute(
        """
        INSERT OR IGNORE INTO agent_bets (id, game_id, matchup, sport, bet_side, line, odds, stake, status, payout, buyback_burned, dividend_distributed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (bet["id"], bet["game_id"], bet["matchup"], bet["sport"], bet["bet_side"], bet["line"], bet["odds"], bet["stake"], bet["status"], bet["payout"], bet["buyback_burned"], bet["dividend_distributed"], bet["created_at"])
      )
      new_bets.append(bet)

  # Settle open bets simulation
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

      # Record burn history event
      conn.execute(
        "INSERT INTO burn_and_payout_history (bet_id, event_type, amount, recipients_count, tx_hash, timestamp) VALUES (?, 'BUYBACK_BURN', ?, 1, ?, ?)",
        (settled["id"], settled["buyback_burned"], f"0xburn_{settled['id']}", now_iso())
      )
      # Record dividend payout history event
      cursor.execute("SELECT COUNT(*) FROM holder_ledger WHERE is_dividend_eligible = 1")
      eligible_count = cursor.fetchone()[0]
      conn.execute(
        "INSERT INTO burn_and_payout_history (bet_id, event_type, amount, recipients_count, tx_hash, timestamp) VALUES (?, 'DIVIDEND_PAYOUT', ?, ?, ?, ?)",
        (settled["id"], settled["dividend_distributed"], eligible_count, f"0xpayout_{settled['id']}", now_iso())
      )

  # Update token stats
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

