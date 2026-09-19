import { useEffect, useMemo, useState } from 'react'

type SportLabel = 'ALL' | 'NFL' | 'NCAAF'
type TabName = 'board' | 'bets'
type SortDirection = 'asc' | 'desc'
type SortKey = 'edge' | 'game' | 'date' | 'line' | 'gap' | 'rating' | 'weather' | 'odds'
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
    weather?: {
      condition?: string | null
      temperature_f?: number | null
      wind_mph?: number | null
    } | null
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

function formatCents(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return `${Math.round(value * 100)}c`
}

function marketTypeLabel(row: BoardRow): string {
  if (row.bet_type === 'total') return 'Total'
  if (row.bet_type === 'moneyline') return 'Moneyline'
  return 'Spread'
}

function consensusLabel(row: BoardRow): string {
  if (row.contract?.side_label) return row.contract.side_label
  if (row.bluechip?.market_team && row.bluechip.market_line) {
    return `${row.bluechip.market_team} ${row.bluechip.market_line}`
  }
  if (row.market.consensus_spread !== null && row.market.consensus_spread !== undefined) {
    const side = row.market.consensus_spread <= 0 ? row.home_team : row.away_team
    return `${side} ${formatSigned(row.market.consensus_spread)}`
  }
  return `${row.away_team} vs ${row.home_team}`
}

function modelGap(row: BoardRow): number | null {
  if (row.metrics.model_market_gap !== null && row.metrics.model_market_gap !== undefined) {
    return row.metrics.model_market_gap
  }
  if (row.bluechip?.gap !== null && row.bluechip?.gap !== undefined) {
    return row.bluechip.gap
  }
  return null
}

function coverOdds(row: BoardRow): number | null {
  if (row.contract?.yes_bid !== null && row.contract?.yes_bid !== undefined) {
    return row.contract.yes_bid
  }
  if (row.contract?.last_price !== null && row.contract?.last_price !== undefined) {
    return row.contract.last_price
  }
  return null
}

function ratingGrade(row: BoardRow): string {
  return row.rating?.grade ?? 'Even'
}

function ratingPercent(row: BoardRow): string {
  const prob = row.contract?.yes_bid ? row.contract.yes_bid / 100.0 : 0.5
  const est = Math.min(0.98, Math.max(0.02, prob + (row.rating?.edge ?? 0)))
  return `${(est * 100).toFixed(1)}%`
}

function ratingClass(row: BoardRow): string {
  const grade = ratingGrade(row).toLowerCase()
  if (grade.includes('strong buy') || grade.includes('excellent')) return 'excellent'
  if (grade.includes('buy') || grade.includes('great')) return 'great'
  if (grade.includes('good')) return 'good'
  if (grade.includes('avoid')) return 'avoid'
  return 'even'
}

function weatherColumnLabel(row: BoardRow): string {
  if (row.weather_impact && row.weather_impact.total_adjustment) {
    return `Impact ${formatSigned(row.weather_impact.total_adjustment)} pts`
  }
  if (row.bluechip?.weather?.condition) return row.bluechip.weather.condition
  return 'Clear'
}

function compareNumber(a: number | null | undefined, b: number | null | undefined, direction: SortDirection): number {
  const numA = a === null || a === undefined || !Number.isFinite(a) ? (direction === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY) : a
  const numB = b === null || b === undefined || !Number.isFinite(b) ? (direction === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY) : b
  if (numA === numB) return 0
  return direction === 'asc' ? numA - numB : numB - numA
}

export function App() {
  const [activeTab, setActiveTab] = useState<TabName>('board')
  const [rows, setRows] = useState<BoardRow[]>([])
  const [source, setSource] = useState('live')
  const [selectedSport, setSelectedSport] = useState<SportLabel>('ALL')
  const [teamSearch, setTeamSearch] = useState('')
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null)
  const [expandedRatingId, setExpandedRatingId] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('gap')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
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

  function toggleSort(nextKey: SortKey) {
    if (nextKey === sortKey) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
      return
    }
    setSortKey(nextKey)
    setSortDirection(nextKey === 'game' || nextKey === 'date' || nextKey === 'line' ? 'asc' : 'desc')
  }

  function sortLabel(key: SortKey) {
    if (key !== sortKey) return ''
    return sortDirection === 'asc' ? ' ▲' : ' ▼'
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

    return [...list].sort((a, b) => {
      if (sortKey === 'game') {
        return (a.away_team + a.home_team).localeCompare(b.away_team + b.home_team) * (sortDirection === 'asc' ? 1 : -1)
      }
      if (sortKey === 'date') {
        return compareNumber(new Date(a.commence_time).getTime(), new Date(b.commence_time).getTime(), sortDirection)
      }
      if (sortKey === 'line') {
        return compareNumber(a.market.consensus_spread, b.market.consensus_spread, sortDirection)
      }
      if (sortKey === 'gap') {
        return compareNumber(modelGap(a), modelGap(b), sortDirection)
      }
      if (sortKey === 'odds') {
        return compareNumber(coverOdds(a), coverOdds(b), sortDirection)
      }
      return compareNumber(a.edge_score, b.edge_score, sortDirection)
    })
  }, [rows, selectedSport, sortDirection, sortKey, teamSearch])

  const selectedRow = filteredRows.find((r) => r.game_id === selectedGameId) || filteredRows[0] || null
  const topGap = rows.reduce<number | null>((largest, r) => {
    const gap = modelGap(r)
    if (gap === null || !Number.isFinite(gap) || gap <= 0) return largest
    return largest === null || gap > largest ? gap : largest
  }, null)

  const latestUpdate = rows.reduce<string | null>((latest, r) => {
    if (!latest) return r.updated_at
    return new Date(r.updated_at) > new Date(latest) ? r.updated_at : latest
  }, null)

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
            📊 Coverage Market Board
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
            <p className="eyebrow">
              {rows.length} lines • Top gap {formatSigned(topGap)} • Blue Chip model • {source} odds • Updated {latestUpdate ? formatDate(latestUpdate) : 'Live'}
            </p>
            <h2>Best edges</h2>
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
            <section className="detail-grid" aria-label="Selected Market Details">
              {selectedRow ? (
                <>
                  <div className="detail-main">
                    <div className="ticket-head">
                      <div>
                        <p className="eyebrow">{selectedRow.sport} / {marketTypeLabel(selectedRow).toUpperCase()}</p>
                        <h3>{selectedRow.away_team} vs {selectedRow.home_team}</h3>
                        <p className="team-breakdown">{selectedRow.away_team} wins</p>
                      </div>

                      <div className={`ticket-rating ${ratingClass(selectedRow)}`}>
                        <span>{ratingGrade(selectedRow)}</span>
                        <strong>{ratingPercent(selectedRow)}</strong>
                      </div>
                    </div>

                    <div className="ticket-grid" aria-label="Selected market details">
                      <div>
                        <span>Line</span>
                        <strong>{consensusLabel(selectedRow)}</strong>
                      </div>
                      <div>
                        <span>Model</span>
                        <strong>{selectedRow.bluechip?.model_line ?? 'Unavailable'}</strong>
                      </div>
                      <div>
                        <span>Gap</span>
                        <strong>{formatSigned(modelGap(selectedRow))}</strong>
                      </div>
                      <div>
                        <span>Odds</span>
                        <strong>{formatCents(coverOdds(selectedRow))}</strong>
                      </div>
                      <div>
                        <span>Move</span>
                        <strong>{formatSigned(selectedRow.metrics.line_move)}</strong>
                      </div>
                      <div>
                        <span>Weather</span>
                        <strong>{weatherColumnLabel(selectedRow)}</strong>
                      </div>
                    </div>

                    {selectedRow.agent_thoughts && selectedRow.agent_thoughts.length > 0 && (
                      <div className="game-agent-thought">
                        <span className="thought-title">🧠 Agent Reasoner:</span>
                        <p>{selectedRow.agent_thoughts[0].thought}</p>
                      </div>
                    )}
                  </div>

                  <div className="detail-stack">
                    <div>
                      <span>Why this rating</span>
                      <strong>{selectedRow.rating?.summary ?? 'Rating explanation unavailable'}</strong>
                      <small>{selectedRow.rating?.explanation}</small>
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
                <div className="empty-panel">No market selected yet.</div>
              )}
            </section>

            <section className="board-panel">
              <div className="panel-heading">
                <div>
                  <h3>Ranked line breakdown</h3>
                  <p>Select a row to update the market breakdown above &amp; steer lines with $CVR.</p>
                </div>
              </div>

              <div className="breakdown-header">
                <button className={sortKey === 'edge' ? 'active' : ''} onClick={() => toggleSort('edge')} type="button">
                  #<span>{sortLabel('edge')}</span>
                </button>
                <button className={sortKey === 'game' ? 'active' : ''} onClick={() => toggleSort('game')} type="button">
                  Game<span>{sortLabel('game')}</span>
                </button>
                <button className={sortKey === 'date' ? 'active' : ''} onClick={() => toggleSort('date')} type="button">
                  Date<span>{sortLabel('date')}</span>
                </button>
                <button className={sortKey === 'line' ? 'active' : ''} onClick={() => toggleSort('line')} type="button">
                  Line<span>{sortLabel('line')}</span>
                </button>
                <button className={sortKey === 'gap' ? 'active' : ''} onClick={() => toggleSort('gap')} type="button">
                  Gap<span>{sortLabel('gap')}</span>
                </button>
                <button className={sortKey === 'rating' ? 'active' : ''} onClick={() => toggleSort('rating')} type="button">
                  Rating<span>{sortLabel('rating')}</span>
                </button>
                <button className={sortKey === 'weather' ? 'active' : ''} onClick={() => toggleSort('weather')} type="button">
                  Weather<span>{sortLabel('weather')}</span>
                </button>
                <button className={sortKey === 'odds' ? 'active' : ''} onClick={() => toggleSort('odds')} type="button">
                  Odds<span>{sortLabel('odds')}</span>
                </button>
              </div>

              <div className="breakdown-list">
                {filteredRows.length ? (
                  filteredRows.map((row, index) => {
                    const expanded = expandedRatingId === row.game_id
                    return (
                      <div className={`breakdown-item ${expanded ? 'expanded' : ''}`} key={row.game_id}>
                        <div
                          className={`breakdown-row ${selectedRow?.game_id === row.game_id ? 'selected' : ''}`}
                          onClick={() => setSelectedGameId(row.game_id)}
                          role="button"
                          tabIndex={0}
                        >
                          <span className="rank">{index + 1}</span>
                          <span className="row-game">
                            <strong>{row.away_team} vs {row.home_team}</strong>
                            <small>{row.sport} / {marketTypeLabel(row)}</small>
                          </span>
                          <span className="row-date">
                            <span className="mobile-label">Date</span>
                            <strong>{formatDate(row.commence_time)}</strong>
                            <small>{row.sport}</small>
                          </span>
                          <span className="row-market">
                            <span className="mobile-label">Line</span>
                            <strong>{consensusLabel(row)}</strong>
                            <small>{row.bluechip?.model_line ? `Model ${row.bluechip.model_line}` : 'Model gap unavailable'}</small>
                          </span>
                          <span className="row-gap">
                            <span className="mobile-label">Gap</span>
                            <strong>{formatSigned(modelGap(row))}</strong>
                          </span>
                          <span className="row-rating">
                            <span className="mobile-label">Rating</span>
                            <button
                              className={`rating-pill ${ratingClass(row)}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedGameId(row.game_id)
                                setExpandedRatingId(expanded ? null : row.game_id)
                              }}
                              type="button"
                            >
                              <strong>{ratingGrade(row)}</strong>
                              <span>{ratingPercent(row)}</span>
                            </button>
                          </span>
                          <span className="row-weather">
                            <span className="mobile-label">Weather</span>
                            <strong>{weatherColumnLabel(row)}</strong>
                            <small>{row.bluechip?.weather?.condition ?? 'No weather'}</small>
                          </span>
                          <span className="row-odds">
                            <span className="mobile-label">Odds</span>
                            <strong>{formatCents(coverOdds(row))}</strong>
                            <small>Move {formatSigned(row.metrics.line_move)}</small>
                          </span>
                        </div>
                        {expanded ? (
                          <div className="rating-explanation">
                            <strong>{row.rating?.summary ?? 'Rating explanation unavailable'}</strong>
                            <p>{row.rating?.explanation}</p>
                            <button
                              className="mini-steer-btn"
                              onClick={() => setSteeringTargetGame(row)}
                            >
                              🎯 Steer This Line ($CVR)
                            </button>
                          </div>
                        ) : null}
                      </div>
                    )
                  })
                ) : (
                  <div className="empty">No live markets match that search.</div>
                )}
              </div>
            </section>
          </>
        )}

        {/* VIEW 2: AGENT BET LEDGER */}
        {activeTab === 'bets' && (
          <section className="bets-page">
            <div className="panel-heading">
              <h3>🤖 Agent Bets &amp; Profit Audit Ledger</h3>
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
