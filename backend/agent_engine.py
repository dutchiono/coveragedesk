import json
import random
import uuid
from datetime import datetime, timezone
from typing import Any

TOTAL_SUPPLY = 1_000_000_000.0  # 1 Billion $COVERAGE


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def generate_thought_and_bet(board_row: dict[str, Any], steering_weights: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """
    Evaluates a game row from CoverageDesk board using model gaps, weather,
    and holder steering weights to produce an agent thought process and optional bet.
    """
    away_team = board_row.get("away_team", "Away")
    home_team = board_row.get("home_team", "Home")
    sport = board_row.get("sport", "NFL")
    metrics = board_row.get("metrics", {})
    gap = metrics.get("model_market_gap") or 0.0
    base_confidence = metrics.get("confidence_score") or 0.65
    
    # Apply steering weights
    underdog_bias = steering_weights.get("underdog_bias", 1.0)
    sport_weight = steering_weights.get("ncaaf_weight", 1.0) if sport == "NCAAF" else steering_weights.get("nfl_weight", 1.0)
    min_edge_threshold = steering_weights.get("min_edge_threshold", 1.5)
    custom_directive = steering_weights.get("custom_directive", "")

    # Market details
    market = board_row.get("market", {})
    consensus_spread = market.get("consensus_spread")
    model = board_row.get("model", {})
    fair_spread = model.get("fair_spread")
    
    # Calculate adjusted edge & confidence
    raw_edge = abs(gap)
    adjusted_edge = raw_edge * sport_weight
    
    if consensus_spread is not None and consensus_spread > 0:
        adjusted_edge *= underdog_bias

    confidence = min(0.98, max(0.40, base_confidence * (1 + (adjusted_edge / 10.0))))

    # Formulate Agent Thought Process
    thought_parts = [
        f"[{sport}] Analyzing matchup: {away_team} vs {home_team}.",
        f"Consensus line: {consensus_spread if consensus_spread is not None else 'N/A'}. Model line: {fair_spread if fair_spread is not None else 'N/A'}.",
        f"Model-vs-Market Gap: {gap:+.1f} pts. Raw Edge: {raw_edge:.2f} pts.",
    ]
    
    if custom_directive:
        thought_parts.append(f"Applying Holder Steering Directive: '{custom_directive}'.")
        
    thought_parts.append(
        f"Adjusted Edge: {adjusted_edge:.2f} (Sport Weight: {sport_weight:.2f}, Underdog Bias: {underdog_bias:.2f}). Required Min Edge: {min_edge_threshold:.1f} pts."
    )

    should_place_bet = adjusted_edge >= min_edge_threshold and consensus_spread is not None

    if should_place_bet:
        side_label = f"{away_team} {consensus_spread}"
        stake = round(random.uniform(500, 2500), 2)
        thought_parts.append(
            f"DECISION: QUALIFIED BET FOUND. Confidence score {confidence*100:.1f}%. Placing automated bet on {side_label} for {stake:,.0f} $COVERAGE bankroll stake."
        )
        bet_obj = {
            "id": f"bet_{uuid.uuid4().hex[:10]}",
            "game_id": board_row.get("game_id", f"{away_team}_{home_team}"),
            "matchup": f"{away_team} vs {home_team}",
            "sport": sport,
            "bet_side": side_label,
            "line": consensus_spread or 0.0,
            "odds": -110,
            "stake": stake,
            "status": "OPEN",
            "payout": 0.0,
            "buyback_burned": 0.0,
            "dividend_distributed": 0.0,
            "created_at": now_iso(),
            "resolved_at": None,
        }
    else:
        thought_parts.append(
            f"DECISION: NO BET. Adjusted edge ({adjusted_edge:.2f}) does not meet threshold requirement ({min_edge_threshold:.1f}). Monitoring line movement."
        )
        bet_obj = None

    thought_obj = {
        "game_id": board_row.get("game_id", f"{away_team}_{home_team}"),
        "matchup": f"{away_team} vs {home_team}",
        "thought": " ".join(thought_parts),
        "confidence": round(confidence, 2),
        "edge": round(adjusted_edge, 2),
        "bet_placed": 1 if should_place_bet else 0,
        "steering_influences": json.dumps(steering_weights),
        "created_at": now_iso(),
    }

    return thought_obj, bet_obj


def settle_bet_outcome(bet: dict[str, Any], result: str = "WON") -> dict[str, Any]:
    """
    Settles an open bet.
    On WIN:
      - Total Payout = stake * 1.91 (typical -110 odds return)
      - Net Profit = stake * 0.91
      - 50% Net Profit -> Buy back & Burn $COVERAGE tokens
      - 50% Net Profit -> Distributed to holders with > 1% total supply
    """
    stake = bet["stake"]
    settled = dict(bet)
    settled["resolved_at"] = now_iso()

    if result == "WON":
        net_profit = round(stake * 0.91, 2)
        total_payout = stake + net_profit
        buyback = round(net_profit * 0.50, 2)
        dividend = round(net_profit * 0.50, 2)
        
        settled["status"] = "WON"
        settled["payout"] = total_payout
        settled["buyback_burned"] = buyback
        settled["dividend_distributed"] = dividend
    elif result == "LOST":
        settled["status"] = "LOST"
        settled["payout"] = 0.0
        settled["buyback_burned"] = 0.0
        settled["dividend_distributed"] = 0.0
    else:
        settled["status"] = "PUSH"
        settled["payout"] = stake
        settled["buyback_burned"] = 0.0
        settled["dividend_distributed"] = 0.0

    return settled
