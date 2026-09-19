import csv
import asyncio
import html
import os
import re
import sqlite3
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI

API_URL = "https://api.the-odds-api.com/v4/sports/{sport}/odds"
SPORTS = {"NFL": "americanfootball_nfl", "NCAAF": "americanfootball_ncaaf"}
KALSHI_API_URL = "https://external-api.kalshi.com/trade-api/v2"
KALSHI_SPREAD_SERIES = {"NFL": "KXNFLSPREAD", "NCAAF": "KXNCAAFSPREAD"}
BLUECHIP_WEEK_URL = os.getenv("BLUECHIP_WEEK_URL", "https://bluechipanalytics.com/college-football/games/2026/week3/")
BLUECHIP_CACHE_SECONDS = int(os.getenv("BLUECHIP_CACHE_SECONDS", "1800"))
ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("MARKBETS_DB", ROOT / "data" / "markbets.sqlite3"))
PROJECTIONS_PATH = Path(os.getenv("MARKBETS_PROJECTIONS", ROOT / "data" / "projections.csv"))

app = FastAPI(title="MarkBets API")
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
  return "|".join(sorted([slugify(away_team), slugify(home_team)]))


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

  return {
    "away_team": away_team,
    "home_team": home_team,
    "market_line": signed_line(market_team, market_spread),
    "model_line": signed_line(model_team, model_spread),
    "market_team": market_team,
    "model_team": model_team,
    "market_spread": market_spread,
    "model_spread": model_spread,
    "gap": float(line_match.group("gap")) if line_match else None,
    "edge_team": clean_text(line_match.group("edge_team")) if line_match else None,
    "summary": clean_text(desc_match.group(1)) if desc_match else None,
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
  limit = int(os.getenv("KALSHI_MARKET_LIMIT", "100"))
  captured_at = now_iso()
  board: list[dict[str, Any]] = []
  bluechip_games = await fetch_bluechip_games()
  async with httpx.AsyncClient(timeout=25) as client:
    for sport_name, series_ticker in KALSHI_SPREAD_SERIES.items():
      response = await client.get(
        f"{KALSHI_API_URL}/markets",
        params={"series_ticker": series_ticker, "status": "open", "limit": limit},
      )
      response.raise_for_status()
      for market in response.json().get("markets", []):
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

        board.append(
          {
            "game_id": market["ticker"],
            "data_source": "kalshi",
            "sport": sport_name,
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
            "metrics": {
              "model_market_gap": bluechip.get("gap") if bluechip else None,
              "line_move": price_move,
              "confidence_score": min(96, 56 + int(fp_to_float(market.get("volume_24h_fp")) > 0) * 12 + int(fp_to_float(market.get("open_interest_fp")) > 0) * 12),
            },
            "updated_at": market.get("updated_time") or captured_at,
          }
        )

  return sorted(
    board,
    key=lambda row: (
      row["metrics"]["model_market_gap"] or 0,
      row["contract"]["volume_24h"],
      row["contract"]["open_interest"],
      abs(row["contract"]["price_move"] or 0),
    ),
    reverse=True,
  ), f"Fetched {len(board)} Kalshi football spread contracts"


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
