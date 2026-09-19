import { useEffect, useMemo, useState } from 'react'

type SportLabel = 'ALL' | 'NFL' | 'NCAAF'
type TabName = 'board' | 'bets'
const REFRESH_MS = 5 * 60 * 1000

type RatingInfo = {
  grade: string
  edge: number
  summary: string
  explanation: string
  gap_points: number
  price_edge_cents: number
}

type AgentThought = {
  id: number
  thought: string
  confidence: number
  edge: number
  bet_placed: number
  created_at: string
}

type SteeringInfo = {
  holder_address: string
  burned_tokens: number
  underdog_bias: number
  ncaaf_weight: number
  nfl_weight: number
  min_edge_threshold: number
  custom_directive: string
  created_at: string
}

type BoardRow = {
  game_id: string
  data_source?: 'sportsbook' | 'kalshi'
  sport: 'NFL' | 'NCAAF'
  bet_type?: 'spread' | 'total' | 'moneyline'
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
    confidence: number
  } | null
  rating?: RatingInfo
  metrics: {
    model_market_gap: number | null
    line_move: number | null
    confidence_score: number
  }
  steering?: SteeringInfo | null
  agent_thoughts?: AgentThought[]
  updated_at: string
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
  if (value === null || value === undefined) return '0 $CVR'
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} $CVR`
}

export function App() {
  const [activeTab, setActiveTab] = useState<TabName>('board')
  const [rows, setRows] = useState<BoardRow[]>([])
  const [source, setSource] = useState('live')
  const [selectedSport, setSelectedSport] = useState<SportLabel>('ALL')
  const [teamSearch, setTeamSearch] = useState('')
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Tokenomics & Bets State
  const [tokenStats, setTokenStats] = useState<TokenStats | null>(null)
  const [agentBets, setAgentBets] = useState<AgentBet[]>([])
  const [holders, setHolders] = useState<Holder[]>([])
  const [userAddress, setUserAddress] = useState('5vRt8...SteeringHolder')

  // Modals State
  const [isTokenModalOpen, setIsTokenModalOpen] = useState(false)
  const [steeringTargetGame, setSteeringTargetGame] = useState<BoardRow | null>(null)

  // Game Steering Form State
  const [steerBurnTokens, setSteerBurnTokens] = useState(50000)
  const [steerBias, setSteerBias] = useState(1.3)
  const [steerDirective, setSteerDirective] = useState('Heavy underdog spread gap advantage.')
  const [steerMessage, setSteerMessage] = useState<string | null>(null)

  async function loadData() {
    setRefreshing(true)
    try {
      const [boardRes, betsRes, statsRes, holdersRes] = await Promise.all([
        fetch('/api/board').then((r) => r.json()),
        fetch('/api/agent/bets').then((r) => r.json()).catch(() => ({ bets: [] })),
        fetch('/api/agent/token-stats').then((r) => r.json()).catch(() => null),
        fetch('/api/agent/holders').then((r) => r.json()).catch(() => ({ holders: [] })),
      ])

      if (boardRes && Array.isArray(boardRes.rows)) {
        setRows(boardRes.rows)
        setSource(boardRes.source)
      }
      if (betsRes && Array.isArray(betsRes.bets)) setAgentBets(betsRes.bets)
      if (statsRes) setTokenStats(statsRes)
      if (holdersRes && Array.isArray(holdersRes.holders)) setHolders(holdersRes.holders)
    } catch (err) {
      console.error('Failed to load CoverageDesk data', err)
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadData()
    const timer = setInterval(loadData, REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  async function handleGameSteerSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!steeringTargetGame) return
    setSteerMessage('Burning $CVR to weight this line...')
    try {
      const res = await fetch('/api/agent/steer-game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          game_id: steeringTargetGame.game_id,
          holder_address: userAddress,
          burned_tokens: steerBurnTokens,
          underdog_bias: steerBias,
          ncaaf_weight: 1.2,
          nfl_weight: 1.0,
          min_edge_threshold: 1.5,
          custom_directive: steerDirective,
        }),
      }).then((r) => r.json())

      if (res.ok) {
        setSteerMessage(`🔥 Successfully burned ${steerBurnTokens.toLocaleString()} $CVR to weight ${steeringTargetGame.away_team} vs ${steeringTargetGame.home_team}!`)
        await loadData()
        setTimeout(() => setSteeringTargetGame(null), 1800)
      } else {
        setSteerMessage(`Steering failed: ${res.detail || 'Must hold ≥ 0.5% $CVR supply.'}`)
      }
    } catch {
      setSteerMessage('Failed to reach steering server.')
    }
  }

  const currentUserHolder = useMemo(() => {
    return holders.find((h) => h.address.toLowerCase() === userAddress.toLowerCase()) || holders[3] || null
  }, [holders, userAddress])

  const filteredRows = useMemo(() => {
    let list = rows
    if (selectedSport !== 'ALL') {
      list = list.filter((r) => r.sport === selectedSport)
    }
    if (teamSearch.trim()) {
      const q = teamSearch.toLowerCase()
      list = list.filter((r) => r.away_team.toLowerCase().includes(q) || r.home_team.toLowerCase().includes(q))
    }
    return list
  }, [rows, selectedSport, teamSearch])

  const selectedRow = filteredRows.find((r) => r.game_id === selectedGameId) || filteredRows[0] || null

  return (
    <main className="shell">
      <aside className="sidebar" aria-label="Controls">
        <div className="brand">
          <span className="brand-mark">CD</span>
          <div>
            <p>CoverageDesk</p>
            <h1>Coverage Desk</h1>
          </div>
        </div>

        <div className="user-wallet-card">
          <span className="card-label">Holder Wallet</span>
          <select value={userAddress} onChange={(e) => setUserAddress(e.target.value)} className="wallet-select">
            {holders.map((h) => (
              <option key={h.address} value={h.address}>
                {h.address} ({h.percentage.toFixed(2)}%)
              </option>
            ))}
          </select>

          <div className="tier-badges">
            {currentUserHolder?.is_dividend_eligible === 1 && (
              <span className="badge div-badge">💰 &gt;1% Dividend Qualified</span>
            )}
            {currentUserHolder?.is_steering_eligible === 1 && (
              <span className="badge steer-badge">🎯 ≥0.5% Line Steer Qualified</span>
            )}
          </div>
        </div>

        <nav className="side-nav">
          <button className={activeTab === 'board' ? 'active' : ''} onClick={() => setActiveTab('board')}>
            📊 Spread Market Board
          </button>
          <button className={activeTab === 'bets' ? 'active' : ''} onClick={() => setActiveTab('bets')}>
            🤖 Agent Bet Ledger ({agentBets.length})
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

        <div className="data-source token-card" onClick={() => setIsTokenModalOpen(true)}>
          <div className="token-header">
            <span>Coverage Protocol</span>
            <strong className="cvr-ticker">$CVR</strong>
          </div>
          <small>{refreshing ? 'Updating live lines...' : `Bankroll: ${formatCurrency(tokenStats?.bankroll_balance)}`}</small>
          <small className="click-hint">Click for Tokenomics &amp; Holders Ledger ➔</small>
        </div>
      </aside>

      <section className="content">
        <div className="topbar">
          <div>
            <p className="eyebrow">coveragedesk.online • {source} feed</p>
            <h2>
              {activeTab === 'board' && 'Consensus Spread & Model Gap Board'}
              {activeTab === 'bets' && 'Automated Agent Bets & Win Dividend Ledger'}
            </h2>
          </div>

          <div className="topbar-actions">
            <button className="tokenomics-btn" onClick={() => setIsTokenModalOpen(true)}>
              🔥 {formatCurrency(tokenStats?.total_burned)} Burned
            </button>
          </div>
        </div>

        {/* VIEW 1: SPREAD MARKET BOARD */}
        {activeTab === 'board' && (
          <>
            <section className="metrics" aria-label="Summary">
              <div>
                <span>Ranked Markets</span>
                <strong>{filteredRows.length.toLocaleString()}</strong>
              </div>
              <div>
                <span>Agent Bankroll</span>
                <strong>{formatCurrency(tokenStats?.bankroll_balance)}</strong>
              </div>
              <div>
                <span>🔥 50% Win Buyback Burn</span>
                <strong>{formatCurrency(tokenStats?.total_burned)}</strong>
              </div>
              <div>
                <span>💰 50% Win Holder Dividends</span>
                <strong>{formatCurrency(tokenStats?.total_distributed)}</strong>
              </div>
            </section>

            <section className="detail-grid">
              {selectedRow ? (
                <>
                  <div className="detail-main">
                    <div className="detail-header-row">
                      <p className="eyebrow">{selectedRow.sport}</p>
                      {selectedRow.rating && (
                        <span className={`grade-pill ${selectedRow.rating.grade.toLowerCase().replace(' ', '-')}`}>
                          {selectedRow.rating.grade}
                        </span>
                      )}
                    </div>

                    <h3>{selectedRow.contract?.title ?? `${selectedRow.away_team} at ${selectedRow.home_team}`}</h3>
                    <p className="team-breakdown">
                      {selectedRow.away_team} vs {selectedRow.home_team}
                      <br />
                      Consensus Spread: <strong>{selectedRow.market.consensus_spread ?? 'N/A'}</strong> | Model Fair Line: <strong>{selectedRow.model.fair_spread ?? 'N/A'}</strong>
                    </p>

                    {selectedRow.agent_thoughts && selectedRow.agent_thoughts.length > 0 && (
                      <div className="game-agent-thought">
                        <span className="thought-title">🧠 Agent Reasoner:</span>
                        <p>{selectedRow.agent_thoughts[0].thought}</p>
                      </div>
                    )}
                  </div>

                  <div className="detail-stack">
                    <div>
                      <span>Model Gap</span>
                      <strong>{formatSigned(selectedRow.metrics.model_market_gap)} pts</strong>
                      <small>{selectedRow.rating?.summary ?? 'Market Edge'}</small>
                    </div>

                    <button
                      className="steer-line-btn"
                      onClick={() => {
                        setSteeringTargetGame(selectedRow)
                        setSteerMessage(null)
                      }}
                    >
                      🎯 Steer Line ($CVR)
                    </button>

                    {selectedRow.steering && (
                      <div className="line-steering-active">
                        <span>🔥 Holder Steered</span>
                        <small>{selectedRow.steering.burned_tokens.toLocaleString()} $CVR burned on this line</small>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="empty-panel">Select a market from the board below.</div>
              )}
            </section>

            <section className="board-panel">
              <div className="panel-heading">
                <h3>Ranked Spread & Total Lines</h3>
                <p>Select a row to inspect agent reasoning &amp; burn $CVR to steer line weights.</p>
              </div>

              <div className="board-table">
                <div className="table-header">
                  <span>Matchup</span>
                  <span>Sport</span>
                  <span>Rating</span>
                  <span>Consensus Spread</span>
                  <span>Model Gap</span>
                  <span>Action</span>
                </div>
                {filteredRows.map((row) => (
                  <div
                    className={`table-row ${selectedRow?.game_id === row.game_id ? 'selected' : ''}`}
                    key={row.game_id}
                    onClick={() => setSelectedGameId(row.game_id)}
                  >
                    <span>
                      <strong>{row.away_team}</strong> @ <strong>{row.home_team}</strong>
                    </span>
                    <span>{row.sport}</span>
                    <span>
                      <span className={`grade-pill mini ${row.rating?.grade.toLowerCase().replace(' ', '-') || 'even'}`}>
                        {row.rating?.grade || 'Even'}
                      </span>
                    </span>
                    <span>{row.market.consensus_spread ?? 'N/A'}</span>
                    <span><strong>{formatSigned(row.metrics.model_market_gap)}</strong></span>
                    <span>
                      <button
                        className="mini-steer-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSteeringTargetGame(row)
                          setSteerMessage(null)
                        }}
                      >
                        🎯 Steer Line
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}

        {/* VIEW 2: AGENT BET LEDGER */}
        {activeTab === 'bets' && (
          <section className="bets-page">
            <div className="panel-heading">
              <h3>🤖 Agent Bets & Profit Audit Ledger</h3>
              <p>50% of net profits from winning bets automatically buy back and burn $CVR, and 50% are distributed to &gt;1% holders.</p>
            </div>

            <div className="bets-table">
              <div className="bets-header">
                <span>Bet ID</span>
                <span>Matchup</span>
                <span>Side / Line</span>
                <span>Stake ($CVR)</span>
                <span>Status</span>
                <span>🔥 50% Buyback Burn</span>
                <span>💰 50% Holder Dividend</span>
                <span>Timestamp</span>
              </div>
              {agentBets.map((b) => (
                <div className="bets-row" key={b.id}>
                  <span><code>{b.id}</code></span>
                  <span>{b.matchup}</span>
                  <span><strong>{b.bet_side}</strong></span>
                  <span>{b.stake.toLocaleString()}</span>
                  <span><span className={`status-badge ${b.status.toLowerCase()}`}>{b.status}</span></span>
                  <span className="burn-text">{b.buyback_burned ? `🔥 ${b.buyback_burned.toLocaleString()}` : '-'}</span>
                  <span className="div-text">{b.dividend_distributed ? `💰 ${b.dividend_distributed.toLocaleString()}` : '-'}</span>
                  <span><small>{formatDate(b.created_at)}</small></span>
                </div>
              ))}
            </div>
          </section>
        )}
      </section>

      {/* MODAL 1: CONTEXTUAL PER-GAME LINE STEERING MODAL */}
      {steeringTargetGame && (
        <div className="modal-backdrop" onClick={() => setSteeringTargetGame(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>🎯 Steer Agent Weight: {steeringTargetGame.away_team} vs {steeringTargetGame.home_team}</h3>
              <button className="close-btn" onClick={() => setSteeringTargetGame(null)}>✕</button>
            </div>

            <form onSubmit={handleGameSteerSubmit} className="modal-form">
              <p className="modal-subtext">
                Holders with <strong>≥ 0.5% $CVR</strong> (5,000,000+ tokens) can burn $CVR to steer the agent's edge weight and strategy bias for this specific matchup.
              </p>

              <label>
                <span>Holder Address</span>
                <input type="text" value={userAddress} disabled />
              </label>

              <label>
                <span>$CVR Tokens to Burn to Weight This Line</span>
                <input
                  type="number"
                  value={steerBurnTokens}
                  onChange={(e) => setSteerBurnTokens(Number(e.target.value))}
                  min={10000}
                  step={5000}
                />
              </label>

              <label>
                <span>Underdog Bias Multiplier: {steerBias}x</span>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.05"
                  value={steerBias}
                  onChange={(e) => setSteerBias(Number(e.target.value))}
                />
              </label>

              <label>
                <span>Custom Strategy Note for Agent</span>
                <input
                  type="text"
                  value={steerDirective}
                  onChange={(e) => setSteerDirective(e.target.value)}
                  placeholder="E.g., Increase confidence weight on away underdog spread..."
                />
              </label>

              <button type="submit" className="burn-action-btn">
                🔥 Burn {steerBurnTokens.toLocaleString()} $CVR &amp; Steer Line
              </button>

              {steerMessage && <div className="modal-banner">{steerMessage}</div>}
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: TOKENOMICS & HOLDERS LEDGER MODAL */}
      {isTokenModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsTokenModalOpen(false)}>
          <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>🔥 Coverage ($CVR) Protocol Metrics &amp; Holders</h3>
              <button className="close-btn" onClick={() => setIsTokenModalOpen(false)}>✕</button>
            </div>

            <div className="modal-body">
              <section className="stats-grid">
                <div className="stat-box">
                  <span>Token Name / Ticker</span>
                  <strong>Coverage ($CVR)</strong>
                </div>
                <div className="stat-box">
                  <span>Total Supply</span>
                  <strong>{tokenStats?.total_supply.toLocaleString()} $CVR</strong>
                </div>
                <div className="stat-box burn-box">
                  <span>🔥 Total Buyback Burn</span>
                  <strong>{formatCurrency(tokenStats?.total_burned)}</strong>
                  <small>50% of net profits from winning bets</small>
                </div>
                <div className="stat-box div-box">
                  <span>💰 Total Holder Dividends</span>
                  <strong>{formatCurrency(tokenStats?.total_distributed)}</strong>
                  <small>50% of net profits paid to &gt;1% holders</small>
                </div>
              </section>

              <section className="holders-section">
                <h4>🏆 Holder Qualification Ledger</h4>
                <div className="holders-table">
                  <div className="holders-header">
                    <span>Address</span>
                    <span>Balance ($CVR)</span>
                    <span>% Supply</span>
                    <span>&gt;1.0% Dividend Tier</span>
                    <span>&ge;0.5% Line Steer Tier</span>
                  </div>
                  {holders.map((h) => (
                    <div className="holders-row" key={h.address}>
                      <span><strong>{h.address}</strong></span>
                      <span>{h.balance.toLocaleString()}</span>
                      <span><strong>{h.percentage.toFixed(2)}%</strong></span>
                      <span>
                        {h.is_dividend_eligible === 1 ? (
                          <span className="badge div-eligible">✅ Dividend Eligible</span>
                        ) : (
                          <span className="badge ineligible">Ineligible</span>
                        )}
                      </span>
                      <span>
                        {h.is_steering_eligible === 1 ? (
                          <span className="badge steer-eligible">🎯 Steer Allowed</span>
                        ) : (
                          <span className="badge ineligible">Ineligible</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
