import { useEffect, useMemo, useState } from 'react'

type SportLabel = 'ALL' | 'NFL' | 'NCAAF'
type TabName = 'board' | 'agent' | 'tokenomics' | 'steering'
const REFRESH_MS = 5 * 60 * 1000

type BoardRow = {
  game_id: string
  data_source?: 'sportsbook' | 'kalshi'
  sport: 'NFL' | 'NCAAF'
  bet_type?: 'spread' | 'total'
  edge_score?: number
  commence_time: string
  away_team: string
  home_team: string
  market: {
    consensus_spread: number | null
    best_favorite_line: number | null
    best_underdog_line: number | null
    opening_spread: number | null
    book_count: number
    latest_book: string | null
    latest_timestamp: string | null
  }
  model: {
    fair_spread: number | null
    source: string | null
    updated_at: string | null
  }
  contract?: {
    ticker: string
    title: string
    side_label: string | null
    yes_bid: number | null
    yes_ask: number | null
    no_bid: number | null
    no_ask: number | null
    last_price: number | null
    previous_price: number | null
    price_move: number | null
    volume: number
    volume_24h: number
    open_interest: number
    status: string | null
  }
  bluechip?: {
    market_line: string | null
    model_line: string | null
    market_team: string | null
    model_team: string | null
    market_spread: number | null
    model_spread: number | null
    gap: number | null
    edge_team: string | null
    summary: string | null
    weather: {
      venue: string | null
      condition: string | null
      temperature_f: number | null
      wind_mph: number | null
      source: string
      map_url: string | null
    }
    source: string
    url: string
    updated_at: string | null
  } | null
  weather_impact?: {
    score: number
    category: string
    wind_impact: number
    precipitation_impact: number
    temperature_impact: number
    spread_adjustment: number
    total_adjustment: number
    adjusted_total: number | null
    adjusted_spread: number | null
    projected_score: {
      team_a_points: number
      team_b_points: number
    } | null
    confidence: number
    assumptions: {
      rain_pct: number
      snow_in: number
      gust_mph: number
    }
  } | null
  metrics: {
    model_market_gap: number | null
    line_move: number | null
    confidence_score: number
  }
  updated_at: string
}

type BoardResponse = {
  generated_at: string
  source: 'sportsbook' | 'kalshi' | 'live' | 'preview'
  status: string
  rows: BoardRow[]
}

type AgentThought = {
  id: number
  game_id: string
  matchup: string
  thought: string
  confidence: number
  edge: number
  bet_placed: number
  steering_influences: string
  created_at: string
}

type AgentBet = {
  id: string
  game_id: string
  matchup: string
  sport: string
  bet_side: string
  line: number
  odds: number
  stake: number
  status: 'OPEN' | 'WON' | 'LOST' | 'PUSH'
  payout: number
  buyback_burned: number
  dividend_distributed: number
  created_at: string
  resolved_at: string | null
}

type TokenStats = {
  total_supply: number
  bankroll_balance: number
  total_fees_collected: number
  total_burned: number
  total_distributed: number
  total_wins: number
  total_losses: number
  win_rate: number
  updated_at: string
}

type Holder = {
  address: string
  balance: number
  percentage: number
  is_dividend_eligible: number
  is_steering_eligible: number
  updated_at: string
}

type SteeringStatus = {
  holder_address?: string
  burned_tokens: number
  underdog_bias: number
  ncaaf_weight: number
  nfl_weight: number
  min_edge_threshold: number
  custom_directive: string
  created_at: string
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function formatSigned(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return `${value > 0 ? '+' : ''}${value.toFixed(decimals)}`
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '0 $COVERAGE'
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} $COVERAGE`
}

export function App() {
  const [activeTab, setActiveTab] = useState<TabName>('board')
  const [board, setBoard] = useState<BoardResponse>({
    generated_at: '',
    source: 'live',
    status: 'Initializing',
    rows: [],
  })
  const [selectedSport, setSelectedSport] = useState<SportLabel>('ALL')
  const [teamSearch, setTeamSearch] = useState('')
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Agent & Tokenomics State
  const [agentThoughts, setAgentThoughts] = useState<AgentThought[]>([])
  const [agentBets, setAgentBets] = useState<AgentBet[]>([])
  const [tokenStats, setTokenStats] = useState<TokenStats | null>(null)
  const [holders, setHolders] = useState<Holder[]>([])
  const [steeringStatus, setSteeringStatus] = useState<SteeringStatus | null>(null)
  const [tickMessage, setTickMessage] = useState<string | null>(null)
  const [isTicking, setIsTicking] = useState(false)

  // Steering Form State
  const [steerAddress, setSteerAddress] = useState('5vRt8...SteeringHolder')
  const [steerBurnTokens, setSteerBurnTokens] = useState(250000)
  const [steerUnderdogBias, setSteerUnderdogBias] = useState(1.25)
  const [steerNcaafWeight, setSteerNcaafWeight] = useState(1.20)
  const [steerNflWeight, setSteerNflWeight] = useState(1.00)
  const [steerMinEdge, setSteerMinEdge] = useState(1.50)
  const [steerDirective, setSteerDirective] = useState('Prioritize bad weather college football underdogs with high line movement.')
  const [steerMessage, setSteerMessage] = useState<string | null>(null)

  async function loadData() {
    setRefreshing(true)
    try {
      const [boardRes, thoughtsRes, betsRes, statsRes, holdersRes, steerRes] = await Promise.all([
        fetch('/api/board').then((r) => r.json()),
        fetch('/api/agent/thoughts').then((r) => r.json()).catch(() => ({ thoughts: [] })),
        fetch('/api/agent/bets').then((r) => r.json()).catch(() => ({ bets: [] })),
        fetch('/api/agent/token-stats').then((r) => r.json()).catch(() => null),
        fetch('/api/agent/holders').then((r) => r.json()).catch(() => ({ holders: [] })),
        fetch('/api/agent/steering-status').then((r) => r.json()).catch(() => null),
      ])

      if (boardRes && Array.isArray(boardRes.rows)) {
        setBoard(boardRes)
      }
      if (thoughtsRes && Array.isArray(thoughtsRes.thoughts)) setAgentThoughts(thoughtsRes.thoughts)
      if (betsRes && Array.isArray(betsRes.bets)) setAgentBets(betsRes.bets)
      if (statsRes) setTokenStats(statsRes)
      if (holdersRes && Array.isArray(holdersRes.holders)) setHolders(holdersRes.holders)
      if (steerRes) setSteeringStatus(steerRes)
    } catch (err) {
      console.error('Failed to load data', err)
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadData()
    const timer = setInterval(loadData, REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  async function triggerAgentTick() {
    setIsTicking(true)
    setTickMessage('Running CoverageDesk Agent evaluation cycle...')
    try {
      const res = await fetch('/api/agent/tick', { method: 'POST' }).then((r) => r.json())
      if (res.ok) {
        setTickMessage(`Cycle complete! Processed ${res.processed_thoughts} thoughts, placed ${res.placed_bets} bets. Burned ${res.buyback_burned_tokens.toLocaleString()} $COVERAGE!`)
        await loadData()
      } else {
        setTickMessage('Agent tick failed.')
      }
    } catch {
      setTickMessage('Error triggering agent tick.')
    } finally {
      setIsTicking(false)
    }
  }

  async function handleSteerSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSteerMessage('Submitting steering transaction & burning tokens...')
    try {
      const res = await fetch('/api/agent/steer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          holder_address: steerAddress,
          burned_tokens: steerBurnTokens,
          underdog_bias: steerUnderdogBias,
          ncaaf_weight: steerNcaafWeight,
          nfl_weight: steerNflWeight,
          min_edge_threshold: steerMinEdge,
          custom_directive: steerDirective,
        }),
      }).then((r) => r.json())

      if (res.ok) {
        setSteerMessage(`Successfully burned ${steerBurnTokens.toLocaleString()} $COVERAGE to steer agent weights!`)
        await loadData()
      } else {
        setSteerMessage(`Steering failed: ${res.detail || 'Insufficient token balance or qualification.'}`)
      }
    } catch {
      setSteerMessage('Failed to connect to steering endpoint.')
    }
  }

  const filteredRows = useMemo(() => {
    let list = board.rows
    if (selectedSport !== 'ALL') {
      list = list.filter((r) => r.sport === selectedSport)
    }
    if (teamSearch.trim()) {
      const q = teamSearch.toLowerCase()
      list = list.filter((r) => r.away_team.toLowerCase().includes(q) || r.home_team.toLowerCase().includes(q))
    }
    return list
  }, [board.rows, selectedSport, teamSearch])

  const selectedRow = filteredRows.find((r) => r.game_id === selectedGameId) || filteredRows[0] || null

  return (
    <main className="shell">
      <aside className="sidebar" aria-label="Controls">
        <div className="brand">
          <span className="brand-mark">CD</span>
          <div>
            <p>CoverageDesk</p>
            <h1>Agentic Spread Protocol</h1>
          </div>
        </div>

        <nav className="tab-nav">
          <button className={activeTab === 'board' ? 'active' : ''} onClick={() => setActiveTab('board')}>
            📊 Spread Board
          </button>
          <button className={activeTab === 'agent' ? 'active' : ''} onClick={() => setActiveTab('agent')}>
            🤖 Agent Terminal ({agentBets.length})
          </button>
          <button className={activeTab === 'tokenomics' ? 'active' : ''} onClick={() => setActiveTab('tokenomics')}>
            🔥 Token & Holders
          </button>
          <button className={activeTab === 'steering' ? 'active' : ''} onClick={() => setActiveTab('steering')}>
            🎯 Holder Steering (≥0.5%)
          </button>
        </nav>

        {activeTab === 'board' && (
          <>
            <label className="field">
              <span>Team search</span>
              <input
                onChange={(e) => setTeamSearch(e.target.value)}
                placeholder="BYU, Texas, Notre Dame"
                type="search"
                value={teamSearch}
              />
            </label>

            <div className="field">
              <span>Sport</span>
              <div className="segmented three">
                {(['ALL', 'NFL', 'NCAAF'] as SportLabel[]).map((sport) => (
                  <button
                    className={selectedSport === sport ? 'selected' : ''}
                    key={sport}
                    onClick={() => setSelectedSport(sport)}
                    type="button"
                  >
                    {sport}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="data-source">
          <span>Token Ticker</span>
          <strong className="token-ticker">$COVERAGE</strong>
          <small>{refreshing ? 'Updating live feed...' : `Bankroll: ${formatCurrency(tokenStats?.bankroll_balance)}`}</small>
          <small>Total Burned: {formatCurrency(tokenStats?.total_burned)}</small>
        </div>
      </aside>

      <section className="content">
        <div className="topbar">
          <div>
            <p className="eyebrow">coveragedesk.online</p>
            <h2>
              {activeTab === 'board' && 'Consensus Spread & Model Gap Board'}
              {activeTab === 'agent' && 'Autonomous Betting Agent Terminal'}
              {activeTab === 'tokenomics' && 'Tokenomics, Buyback/Burn & Holder Dividends'}
              {activeTab === 'steering' && 'Holder Strategy Steering (≥ 0.5% Token Supply)'}
            </h2>
          </div>
          <button className="action-btn" disabled={isTicking} onClick={triggerAgentTick}>
            {isTicking ? 'Agent Thinking...' : '⚡ Run Agent Decision Cycle'}
          </button>
        </div>

        {tickMessage && <div className="banner-notify">{tickMessage}</div>}

        {/* TAB 1: SPREAD BOARD */}
        {activeTab === 'board' && (
          <>
            <section className="metrics" aria-label="Summary">
              <div>
                <span>Markets</span>
                <strong>{filteredRows.length.toLocaleString()}</strong>
              </div>
              <div>
                <span>Agent Bankroll</span>
                <strong>{formatCurrency(tokenStats?.bankroll_balance)}</strong>
              </div>
              <div>
                <span>Total Burned</span>
                <strong>{formatCurrency(tokenStats?.total_burned)}</strong>
              </div>
              <div>
                <span>{'>'}1% Dividends Paid</span>
                <strong>{formatCurrency(tokenStats?.total_distributed)}</strong>
              </div>
            </section>

            <section className="detail-grid">
              {selectedRow ? (
                <>
                  <div className="detail-main">
                    <p className="eyebrow">{selectedRow.sport}</p>
                    <h3>{selectedRow.away_team} at {selectedRow.home_team}</h3>
                    <p className="team-breakdown">
                      Consensus Line: {selectedRow.market.consensus_spread ?? 'N/A'} | Model Fair Line: {selectedRow.model.fair_spread ?? 'N/A'}
                    </p>
                  </div>
                  <div className="detail-stack">
                    <div>
                      <span>Model Gap</span>
                      <strong>{formatSigned(selectedRow.metrics.model_market_gap)} pts</strong>
                    </div>
                    <div>
                      <span>Agent Confidence</span>
                      <strong>{(selectedRow.metrics.confidence_score * 100).toFixed(0)}%</strong>
                    </div>
                  </div>
                </>
              ) : (
                <div className="empty-panel">Select a market from the board below.</div>
              )}
            </section>

            <section className="board-panel">
              <div className="panel-heading">
                <h3>Live Spread Markets</h3>
              </div>
              <div className="board-table">
                <div className="table-header">
                  <span>Matchup</span>
                  <span>Sport</span>
                  <span>Consensus Spread</span>
                  <span>Model Gap</span>
                  <span>Confidence</span>
                </div>
                {filteredRows.map((row) => (
                  <button
                    className={`table-row ${selectedRow?.game_id === row.game_id ? 'selected' : ''}`}
                    key={row.game_id}
                    onClick={() => setSelectedGameId(row.game_id)}
                  >
                    <span><strong>{row.away_team}</strong> @ <strong>{row.home_team}</strong></span>
                    <span>{row.sport}</span>
                    <span>{row.market.consensus_spread ?? 'N/A'}</span>
                    <span><strong>{formatSigned(row.metrics.model_market_gap)}</strong></span>
                    <span>{(row.metrics.confidence_score * 100).toFixed(0)}%</span>
                  </button>
                ))}
              </div>
            </section>
          </>
        )}

        {/* TAB 2: AGENT TERMINAL */}
        {activeTab === 'agent' && (
          <div className="agent-terminal-layout">
            <section className="agent-thoughts-card">
              <h3>🧠 Live Agent Thought Stream</h3>
              <p className="subtext">Real-time reasoning logs generated by CoverageDesk AI during market evaluation.</p>
              <div className="thought-stream">
                {agentThoughts.map((t) => (
                  <div className="thought-item" key={t.id}>
                    <div className="thought-header">
                      <span className="matchup-tag">{t.matchup}</span>
                      <span className="time-tag">{formatDate(t.created_at)}</span>
                      {t.bet_placed === 1 && <span className="badge bet-badge">BET PLACED</span>}
                    </div>
                    <p className="thought-text">{t.thought}</p>
                    <div className="thought-footer">
                      <span>Edge: {t.edge} pts</span>
                      <span>Confidence: {(t.confidence * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="agent-bets-card">
              <h3>🎯 Automated Agent Bets</h3>
              <p className="subtext">Bets placed using token fee bankroll. Wins trigger 50% Buyback/Burn + 50% &gt;1% Holder Payout.</p>
              <div className="bets-table">
                <div className="bets-header">
                  <span>Bet ID</span>
                  <span>Matchup</span>
                  <span>Side / Line</span>
                  <span>Stake</span>
                  <span>Status</span>
                  <span>50% Burned</span>
                  <span>50% Dividend</span>
                </div>
                {agentBets.map((b) => (
                  <div className="bets-row" key={b.id}>
                    <span>{b.id}</span>
                    <span>{b.matchup}</span>
                    <span><strong>{b.bet_side}</strong></span>
                    <span>{b.stake.toLocaleString()} $COVERAGE</span>
                    <span><span className={`status-badge ${b.status.toLowerCase()}`}>{b.status}</span></span>
                    <span className="burn-text">{b.buyback_burned ? `🔥 ${b.buyback_burned.toLocaleString()}` : '-'}</span>
                    <span className="div-text">{b.dividend_distributed ? `💰 ${b.dividend_distributed.toLocaleString()}` : '-'}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* TAB 3: TOKENOMICS & HOLDERS */}
        {activeTab === 'tokenomics' && (
          <div className="tokenomics-layout">
            <section className="stats-grid">
              <div className="stat-box">
                <span>Total Supply</span>
                <strong>{tokenStats?.total_supply.toLocaleString()} $COVERAGE</strong>
              </div>
              <div className="stat-box">
                <span>Agent Betting Bankroll</span>
                <strong>{formatCurrency(tokenStats?.bankroll_balance)}</strong>
              </div>
              <div className="stat-box burn-box">
                <span>🔥 Total Buyback & Burned</span>
                <strong>{formatCurrency(tokenStats?.total_burned)}</strong>
                <small>50% of all agent winning bets</small>
              </div>
              <div className="stat-box div-box">
                <span>💰 Total Holder Payouts (&gt;1%)</span>
                <strong>{formatCurrency(tokenStats?.total_distributed)}</strong>
                <small>50% of all agent winning bets</small>
              </div>
            </section>

            <section className="holders-card">
              <h3>🏆 Holder Leaderboard & Qualification Tiers</h3>
              <p className="subtext">
                Holders owning <strong>&gt; 1.0%</strong> qualify for automatic 50% win dividend distributions.<br />
                Holders owning <strong>&ge; 0.5%</strong> qualify to burn tokens and steer agent strategy weights.
              </p>

              <div className="holders-table">
                <div className="holders-header">
                  <span>Wallet Address</span>
                  <span>Balance ($COVERAGE)</span>
                  <span>% Supply</span>
                  <span>&gt;1% Dividend Tier</span>
                  <span>&ge;0.5% Steering Tier</span>
                </div>
                {holders.map((h) => (
                  <div className="holders-row" key={h.address}>
                    <span><strong>{h.address}</strong></span>
                    <span>{h.balance.toLocaleString()}</span>
                    <span><strong>{h.percentage.toFixed(2)}%</strong></span>
                    <span>
                      {h.is_dividend_eligible === 1 ? (
                        <span className="badge div-eligible">✅ Eligible (&gt;1%)</span>
                      ) : (
                        <span className="badge ineligible">Ineligible</span>
                      )}
                    </span>
                    <span>
                      {h.is_steering_eligible === 1 ? (
                        <span className="badge steer-eligible">🎯 Steering Allowed</span>
                      ) : (
                        <span className="badge ineligible">Needs ≥0.5%</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* TAB 4: HOLDER STEERING */}
        {activeTab === 'steering' && (
          <div className="steering-layout">
            <section className="active-steering-card">
              <h3>🎯 Active Community Steering Parameters</h3>
              <p className="subtext">Current bias weights influencing CoverageDesk Agent decision engine.</p>
              {steeringStatus && (
                <div className="weights-grid">
                  <div><span>Underdog Bias:</span> <strong>{steeringStatus.underdog_bias}x</strong></div>
                  <div><span>NCAAF Weight:</span> <strong>{steeringStatus.ncaaf_weight}x</strong></div>
                  <div><span>NFL Weight:</span> <strong>{steeringStatus.nfl_weight}x</strong></div>
                  <div><span>Min Edge Threshold:</span> <strong>{steeringStatus.min_edge_threshold} pts</strong></div>
                  <div className="directive-box"><span>Custom Strategy Directive:</span> <em>"{steeringStatus.custom_directive}"</em></div>
                </div>
              )}
            </section>

            <section className="steering-form-card">
              <h3>🔥 Burn Tokens to Steer Agent</h3>
              <p className="subtext">Must hold ≥ 0.5% of $COVERAGE (5,000,000 tokens). Tokens burned during steering are permanently removed from supply.</p>

              <form onSubmit={handleSteerSubmit} className="steer-form">
                <label>
                  <span>Holder Wallet Address</span>
                  <input
                    type="text"
                    value={steerAddress}
                    onChange={(e) => setSteerAddress(e.target.value)}
                    placeholder="Enter wallet address"
                    required
                  />
                </label>

                <label>
                  <span>Tokens to Burn for Steering ($COVERAGE)</span>
                  <input
                    type="number"
                    value={steerBurnTokens}
                    onChange={(e) => setSteerBurnTokens(Number(e.target.value))}
                    min={50000}
                    step={10000}
                  />
                </label>

                <div className="slider-group">
                  <label>
                    <span>Underdog Bias Multiplier: {steerUnderdogBias}x</span>
                    <input
                      type="range"
                      min="0.5"
                      max="2.0"
                      step="0.05"
                      value={steerUnderdogBias}
                      onChange={(e) => setSteerUnderdogBias(Number(e.target.value))}
                    />
                  </label>

                  <label>
                    <span>NCAAF Sport Weight: {steerNcaafWeight}x</span>
                    <input
                      type="range"
                      min="0.5"
                      max="2.0"
                      step="0.05"
                      value={steerNcaafWeight}
                      onChange={(e) => setSteerNcaafWeight(Number(e.target.value))}
                    />
                  </label>

                  <label>
                    <span>NFL Sport Weight: {steerNflWeight}x</span>
                    <input
                      type="range"
                      min="0.5"
                      max="2.0"
                      step="0.05"
                      value={steerNflWeight}
                      onChange={(e) => setSteerNflWeight(Number(e.target.value))}
                    />
                  </label>

                  <label>
                    <span>Min Edge Threshold: {steerMinEdge} pts</span>
                    <input
                      type="range"
                      min="0.5"
                      max="4.0"
                      step="0.1"
                      value={steerMinEdge}
                      onChange={(e) => setSteerMinEdge(Number(e.target.value))}
                    />
                  </label>
                </div>

                <label>
                  <span>Strategy Directive Prompt for Agent</span>
                  <textarea
                    rows={3}
                    value={steerDirective}
                    onChange={(e) => setSteerDirective(e.target.value)}
                    placeholder="E.g., Target high-wind NCAAF underdogs with high line movement..."
                  />
                </label>

                <button type="submit" className="burn-steer-btn">
                  🔥 Burn {steerBurnTokens.toLocaleString()} $COVERAGE & Apply Steering
                </button>
              </form>
              {steerMessage && <div className="banner-notify">{steerMessage}</div>}
            </section>
          </div>
        )}
      </section>
    </main>
  )
}

export default App
