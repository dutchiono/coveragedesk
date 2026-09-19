import { useEffect, useMemo, useState, type FormEvent } from 'react'

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

const emptyBoard: BoardResponse = {
  generated_at: new Date().toISOString(),
  source: 'preview',
  status: 'Loading market board',
  rows: [],
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function formatNumber(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits)
}

function formatSigned(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`
}

function formatCoverage(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} COVERAGE`
}

function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  const percent = value <= 1 ? value * 100 : value
  return `${percent.toFixed(digits)}%`
}

function formatCents(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return `${Math.round(value * 100)}c`
}

function modelGap(row: BoardRow): number | null {
  return row.bluechip?.gap ?? row.metrics.model_market_gap ?? null
}

function coverPrice(row: BoardRow): number | null {
  return row.contract?.last_price ?? row.contract?.yes_bid ?? row.contract?.yes_ask ?? null
}

function marketTypeLabel(row: BoardRow): string {
  return row.bet_type === 'total' ? 'Total' : 'Spread'
}

function consensusLabel(row: BoardRow): string {
  if (row.data_source === 'kalshi' && row.contract) {
    const strike = row.market.consensus_spread
    const suffix = strike === null ? '' : ` > ${formatNumber(strike)}`
    return `${row.contract.side_label ?? row.contract.title}${suffix}`
  }
  const spread = row.market.consensus_spread
  if (spread === null) return '-'
  if (spread < 0) return `${row.home_team} ${spread.toFixed(1)}`
  if (spread > 0) return `${row.away_team} ${(-spread).toFixed(1)}`
  return 'Pick'
}

function weatherLabel(row: BoardRow): string {
  const impact = row.weather_impact
  const condition = row.bluechip?.weather?.condition
  if (!impact) return condition ?? '-'
  if (Math.abs(impact.total_adjustment) < 0.1) return condition ?? impact.category
  return `${condition ?? impact.category} ${formatSigned(impact.total_adjustment)} total`
}

function edgeGrade(row: BoardRow): 'prime' | 'strong' | 'lean' | 'watch' {
  const gap = Math.abs(modelGap(row) ?? 0)
  if (gap >= 4) return 'prime'
  if (gap >= 2.5) return 'strong'
  if (gap >= 1) return 'lean'
  return 'watch'
}

function edgeGradeLabel(row: BoardRow): string {
  const grade = edgeGrade(row)
  if (grade === 'prime') return 'Prime'
  if (grade === 'strong') return 'Strong'
  if (grade === 'lean') return 'Lean'
  return 'Watch'
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\bst[.]?\b/g, 'state').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
}

function rowMatches(row: BoardRow, query: string): boolean {
  const normalized = normalize(query)
  if (!normalized) return true
  const haystack = `${normalize(row.away_team)} ${normalize(row.home_team)} ${normalize(row.contract?.title ?? '')}`
  return normalized.split(' ').filter(Boolean).every((token) => haystack.includes(token))
}

function compactAddress(address: string): string {
  if (address.length <= 18) return address
  return `${address.slice(0, 8)}...${address.slice(-6)}`
}

async function fetchBoard(): Promise<BoardResponse> {
  try {
    const response = await fetch('/api/board', { cache: 'no-store' })
    if (!response.ok) throw new Error('Board API unavailable')
    return (await response.json()) as BoardResponse
  } catch {
    const response = await fetch('/data/board-preview.json', { cache: 'no-store' })
    if (!response.ok) return emptyBoard
    return { ...((await response.json()) as BoardResponse), source: 'preview' }
  }
}

export function App() {
  const [activeTab, setActiveTab] = useState<TabName>('board')
  const [board, setBoard] = useState<BoardResponse>(emptyBoard)
  const [selectedSport, setSelectedSport] = useState<SportLabel>('ALL')
  const [teamSearch, setTeamSearch] = useState('')
  const [selectedGameId, setSelectedGameId] = useState<string>('')
  const [refreshing, setRefreshing] = useState(false)

  const [agentThoughts, setAgentThoughts] = useState<AgentThought[]>([])
  const [agentBets, setAgentBets] = useState<AgentBet[]>([])
  const [tokenStats, setTokenStats] = useState<TokenStats | null>(null)
  const [holders, setHolders] = useState<Holder[]>([])
  const [steeringStatus, setSteeringStatus] = useState<SteeringStatus | null>(null)
  const [tickMessage, setTickMessage] = useState<string | null>(null)
  const [isTicking, setIsTicking] = useState(false)

  const [steerAddress, setSteerAddress] = useState('5vRt8...SteeringHolder')
  const [steerBurnTokens, setSteerBurnTokens] = useState(250000)
  const [steerUnderdogBias, setSteerUnderdogBias] = useState(1.25)
  const [steerNcaafWeight, setSteerNcaafWeight] = useState(1.2)
  const [steerNflWeight, setSteerNflWeight] = useState(1)
  const [steerMinEdge, setSteerMinEdge] = useState(1.5)
  const [steerDirective, setSteerDirective] = useState('Prioritize bad weather college football underdogs with high line movement.')
  const [steerMessage, setSteerMessage] = useState<string | null>(null)

  async function loadData(showRefreshing = true) {
    if (showRefreshing) setRefreshing(true)
    try {
      const [boardRes, thoughtsRes, betsRes, statsRes, holdersRes, steerRes] = await Promise.all([
        fetchBoard(),
        fetch('/api/agent/thoughts').then((response) => response.json()).catch(() => ({ thoughts: [] })),
        fetch('/api/agent/bets').then((response) => response.json()).catch(() => ({ bets: [] })),
        fetch('/api/agent/token-stats').then((response) => response.json()).catch(() => null),
        fetch('/api/agent/holders').then((response) => response.json()).catch(() => ({ holders: [] })),
        fetch('/api/agent/steering-status').then((response) => response.json()).catch(() => null),
      ])

      if (boardRes && Array.isArray(boardRes.rows)) setBoard(boardRes)
      if (thoughtsRes && Array.isArray(thoughtsRes.thoughts)) setAgentThoughts(thoughtsRes.thoughts)
      if (betsRes && Array.isArray(betsRes.bets)) setAgentBets(betsRes.bets)
      if (statsRes) setTokenStats(statsRes)
      if (holdersRes && Array.isArray(holdersRes.holders)) setHolders(holdersRes.holders)
      if (steerRes) setSteeringStatus(steerRes)
    } finally {
      if (showRefreshing) setRefreshing(false)
    }
  }

  useEffect(() => {
    void loadData()
    const timer = window.setInterval(() => {
      void loadData(false)
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [])

  async function triggerAgentTick() {
    setIsTicking(true)
    setTickMessage('Running market evaluation cycle...')
    try {
      const response = await fetch('/api/agent/tick', { method: 'POST' }).then((r) => r.json())
      if (response.ok) {
        setTickMessage(
          `Cycle complete: ${response.processed_thoughts} reads, ${response.placed_bets} wagers, ${formatCoverage(response.buyback_burned_tokens)} burned.`,
        )
        await loadData()
      } else {
        setTickMessage('Agent cycle failed.')
      }
    } catch {
      setTickMessage('Agent cycle could not reach the backend.')
    } finally {
      setIsTicking(false)
    }
  }

  async function handleSteerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSteerMessage('Submitting steering burn...')
    try {
      const response = await fetch('/api/agent/steer', {
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

      if (response.ok) {
        setSteerMessage(`Burn accepted: ${formatCoverage(steerBurnTokens)} committed to strategy weights.`)
        await loadData()
      } else {
        setSteerMessage(`Steering rejected: ${response.detail || 'holder is not qualified.'}`)
      }
    } catch {
      setSteerMessage('Steering endpoint unavailable.')
    }
  }

  const rows = useMemo(() => {
    return board.rows
      .filter((row) => selectedSport === 'ALL' || row.sport === selectedSport)
      .filter((row) => rowMatches(row, teamSearch))
      .sort((a, b) => {
        const aEdge = a.edge_score ?? Math.abs(modelGap(a) ?? 0) * 20
        const bEdge = b.edge_score ?? Math.abs(modelGap(b) ?? 0) * 20
        return bEdge - aEdge || Math.abs(modelGap(b) ?? 0) - Math.abs(modelGap(a) ?? 0)
      })
  }, [board.rows, selectedSport, teamSearch])

  const selectedRow = rows.find((row) => row.game_id === selectedGameId) ?? rows[0] ?? null
  const openBets = agentBets.filter((bet) => bet.status === 'OPEN').length
  const settledBets = agentBets.length - openBets
  const topGap = rows.reduce<number | null>((largest, row) => {
    const gap = Math.abs(modelGap(row) ?? 0)
    if (!gap) return largest
    return largest === null || gap > largest ? gap : largest
  }, null)

  return (
    <main className="shell">
      <aside className="sidebar" aria-label="CoverageDesk controls">
        <div className="brand">
          <span className="brand-mark">CD</span>
          <div>
            <p>CoverageDesk</p>
            <h1>Spread Protocol</h1>
          </div>
        </div>

        <nav className="tab-nav" aria-label="Primary views">
          {[
            ['board', 'Board'],
            ['agent', `Agent ${agentBets.length}`],
            ['tokenomics', 'Token'],
            ['steering', 'Steering'],
          ].map(([tab, label]) => (
            <button className={activeTab === tab ? 'active' : ''} key={tab} onClick={() => setActiveTab(tab as TabName)} type="button">
              {label}
            </button>
          ))}
        </nav>

        {activeTab === 'board' && (
          <>
            <label className="field">
              <span>Team search</span>
              <input
                onChange={(event) => setTeamSearch(event.target.value)}
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

        <div className="feed-note">
          <span>{refreshing ? 'Refreshing markets' : 'Auto refresh: 5 min'}</span>
          <small>{rows.length.toLocaleString()} ranked markets</small>
          <small>{board.source === 'preview' ? 'Preview feed' : board.source === 'kalshi' ? 'Kalshi feed' : 'Sportsbook feed'}</small>
        </div>

        <div className="side-ledger">
          <span>Bankroll</span>
          <strong>{formatCoverage(tokenStats?.bankroll_balance)}</strong>
          <small>Burned {formatCoverage(tokenStats?.total_burned)}</small>
          <small>Paid {formatCoverage(tokenStats?.total_distributed)}</small>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">coveragedesk.online</p>
            <h2>
              {activeTab === 'board' && 'Football spread desk'}
              {activeTab === 'agent' && 'Agent ledger'}
              {activeTab === 'tokenomics' && 'Token ledger'}
              {activeTab === 'steering' && 'Holder steering'}
            </h2>
            <p className="board-meta">
              {activeTab === 'board' && `${rows.length.toLocaleString()} markets | Top gap ${formatSigned(topGap)} | Updated ${formatDate(board.generated_at)}`}
              {activeTab === 'agent' && `${openBets} open wagers | ${settledBets} settled | ${agentThoughts.length} market reads`}
              {activeTab === 'tokenomics' && `${formatCoverage(tokenStats?.total_supply)} supply | ${formatPercent(tokenStats?.win_rate, 0)} win rate`}
              {activeTab === 'steering' && `Minimum edge ${formatNumber(steeringStatus?.min_edge_threshold)} pts | Last burn ${formatCoverage(steeringStatus?.burned_tokens)}`}
            </p>
          </div>
          <button className="primary action-btn" disabled={isTicking} onClick={triggerAgentTick} type="button">
            {isTicking ? 'Running cycle' : 'Run decision cycle'}
          </button>
        </header>

        {tickMessage && <div className="notice">{tickMessage}</div>}

        {activeTab === 'board' && (
          <>
            <section className="metrics" aria-label="Board summary">
              <div>
                <span>Markets</span>
                <strong>{rows.length.toLocaleString()}</strong>
              </div>
              <div>
                <span>Top model gap</span>
                <strong>{formatSigned(topGap)}</strong>
              </div>
              <div>
                <span>Bankroll</span>
                <strong>{formatCoverage(tokenStats?.bankroll_balance)}</strong>
              </div>
              <div>
                <span>Open bets</span>
                <strong>{openBets}</strong>
              </div>
            </section>

            <section className="detail-grid">
              {selectedRow ? (
                <>
                  <div className="detail-main">
                    <div className="ticket-head">
                      <div>
                        <p className="eyebrow">{selectedRow.sport} / {marketTypeLabel(selectedRow)}</p>
                        <h3>{selectedRow.away_team} at {selectedRow.home_team}</h3>
                        <p>{selectedRow.contract?.title ?? consensusLabel(selectedRow)}</p>
                      </div>
                      <div className={`ticket-rating ${edgeGrade(selectedRow)}`}>
                        <span>{edgeGradeLabel(selectedRow)}</span>
                        <strong>{formatPercent(selectedRow.metrics.confidence_score)}</strong>
                      </div>
                    </div>

                    <div className="ticket-grid" aria-label="Selected market details">
                      <div>
                        <span>Line</span>
                        <strong>{consensusLabel(selectedRow)}</strong>
                      </div>
                      <div>
                        <span>Model</span>
                        <strong>{selectedRow.bluechip?.model_line ?? formatSigned(selectedRow.model.fair_spread)}</strong>
                      </div>
                      <div>
                        <span>Gap</span>
                        <strong>{formatSigned(modelGap(selectedRow))}</strong>
                      </div>
                      <div>
                        <span>Price</span>
                        <strong>{formatCents(coverPrice(selectedRow))}</strong>
                      </div>
                      <div>
                        <span>Move</span>
                        <strong>{formatSigned(selectedRow.metrics.line_move)}</strong>
                      </div>
                      <div>
                        <span>Weather</span>
                        <strong>{weatherLabel(selectedRow)}</strong>
                      </div>
                    </div>
                  </div>

                  <div className="detail-stack">
                    <div>
                      <span>Source</span>
                      <strong>{selectedRow.market.latest_book ?? selectedRow.data_source ?? 'Market feed'}</strong>
                      <small>{selectedRow.market.book_count} books in consensus</small>
                      <small>Updated {formatDate(selectedRow.updated_at)}</small>
                    </div>
                    <div>
                      <span>Protocol read</span>
                      <strong>{edgeGradeLabel(selectedRow)} edge</strong>
                      <small>Model gap {formatSigned(modelGap(selectedRow))}</small>
                      <small>Weather {weatherLabel(selectedRow)}</small>
                    </div>
                  </div>
                </>
              ) : (
                <div className="empty-panel">No market selected.</div>
              )}
            </section>

            <section className="board-panel">
              <div className="panel-heading">
                <div>
                  <h3>Ranked market board</h3>
                  <p>Select a market to update the ticket above.</p>
                </div>
              </div>
              <div className="breakdown-header">
                <span>#</span>
                <span>Game</span>
                <span>Date</span>
                <span>Line</span>
                <span>Gap</span>
                <span>Read</span>
                <span>Weather</span>
                <span>Price</span>
              </div>
              <div className="breakdown-list">
                {rows.length ? (
                  rows.slice(0, 200).map((row, index) => (
                    <button
                      className={`breakdown-row ${selectedRow?.game_id === row.game_id ? 'selected' : ''}`}
                      key={row.game_id}
                      onClick={() => setSelectedGameId(row.game_id)}
                      type="button"
                    >
                      <span className="rank">{index + 1}</span>
                      <span className="row-game">
                        <strong>{row.away_team} at {row.home_team}</strong>
                        <small>{row.sport} / {marketTypeLabel(row)}</small>
                      </span>
                      <span className="row-date">
                        <span className="mobile-label">Date</span>
                        <strong>{formatDate(row.commence_time)}</strong>
                        <small>{row.market.latest_book ?? row.data_source ?? 'feed'}</small>
                      </span>
                      <span className="row-market">
                        <span className="mobile-label">Line</span>
                        <strong>{consensusLabel(row)}</strong>
                        <small>Model {row.bluechip?.model_line ?? formatSigned(row.model.fair_spread)}</small>
                      </span>
                      <span className="row-gap">
                        <span className="mobile-label">Gap</span>
                        <strong>{formatSigned(modelGap(row))}</strong>
                      </span>
                      <span className="row-rating">
                        <span className="mobile-label">Read</span>
                        <span className={`rating-pill ${edgeGrade(row)}`}>
                          <strong>{edgeGradeLabel(row)}</strong>
                          <span>{formatPercent(row.metrics.confidence_score)}</span>
                        </span>
                      </span>
                      <span className="row-weather">
                        <span className="mobile-label">Weather</span>
                        <strong>{weatherLabel(row)}</strong>
                        <small>{row.bluechip?.weather?.venue ?? 'No venue feed'}</small>
                      </span>
                      <span className="row-odds">
                        <span className="mobile-label">Price</span>
                        <strong>{formatCents(coverPrice(row))}</strong>
                        <small>Move {formatSigned(row.metrics.line_move)}</small>
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="empty">No markets match that search.</div>
                )}
              </div>
            </section>
          </>
        )}

        {activeTab === 'agent' && (
          <div className="two-column">
            <section className="panel">
              <div className="panel-heading compact">
                <div>
                  <h3>Market reads</h3>
                  <p>Recent agent decisions, ordered newest first.</p>
                </div>
              </div>
              <div className="thought-stream">
                {agentThoughts.length ? agentThoughts.map((thought) => (
                  <article className="thought-item" key={thought.id}>
                    <div className="thought-header">
                      <strong>{thought.matchup}</strong>
                      <span>{formatDate(thought.created_at)}</span>
                    </div>
                    <p>{thought.thought}</p>
                    <div className="row-meta">
                      <span>Edge {formatNumber(thought.edge)}</span>
                      <span>Confidence {formatPercent(thought.confidence)}</span>
                      <span>{thought.bet_placed ? 'Bet placed' : 'No bet'}</span>
                    </div>
                  </article>
                )) : <div className="empty">No agent reads yet.</div>}
              </div>
            </section>

            <section className="panel">
              <div className="panel-heading compact">
                <div>
                  <h3>Bet ledger</h3>
                  <p>Settled wins split profit between burns and qualified holders.</p>
                </div>
              </div>
              <div className="ledger-list">
                {agentBets.length ? agentBets.map((bet) => (
                  <article className="ledger-row" key={bet.id}>
                    <div>
                      <strong>{bet.matchup}</strong>
                      <small>{bet.bet_side} / {bet.sport}</small>
                    </div>
                    <span>{formatCoverage(bet.stake)}</span>
                    <span className={`status-badge ${bet.status.toLowerCase()}`}>{bet.status}</span>
                    <span>{formatCoverage(bet.buyback_burned)}</span>
                    <span>{formatCoverage(bet.dividend_distributed)}</span>
                  </article>
                )) : <div className="empty">No bets recorded yet.</div>}
              </div>
            </section>
          </div>
        )}

        {activeTab === 'tokenomics' && (
          <div className="tokenomics-layout">
            <section className="metrics">
              <div>
                <span>Total supply</span>
                <strong>{formatCoverage(tokenStats?.total_supply)}</strong>
              </div>
              <div>
                <span>Bankroll</span>
                <strong>{formatCoverage(tokenStats?.bankroll_balance)}</strong>
              </div>
              <div>
                <span>Total burned</span>
                <strong>{formatCoverage(tokenStats?.total_burned)}</strong>
              </div>
              <div>
                <span>Holder payouts</span>
                <strong>{formatCoverage(tokenStats?.total_distributed)}</strong>
              </div>
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h3>Holder qualification</h3>
                  <p>Dividend threshold is &gt;1% supply. Steering threshold is &gt;=0.5% supply.</p>
                </div>
              </div>
              <div className="holder-table">
                <div className="holder-header">
                  <span>Wallet</span>
                  <span>Balance</span>
                  <span>Supply</span>
                  <span>Dividend</span>
                  <span>Steering</span>
                </div>
                {holders.map((holder) => (
                  <div className="holder-row" key={holder.address}>
                    <strong>{compactAddress(holder.address)}</strong>
                    <span>{formatCoverage(holder.balance)}</span>
                    <span>{holder.percentage.toFixed(2)}%</span>
                    <span className={holder.is_dividend_eligible ? 'yes' : 'no'}>{holder.is_dividend_eligible ? 'Qualified' : 'Below tier'}</span>
                    <span className={holder.is_steering_eligible ? 'yes' : 'no'}>{holder.is_steering_eligible ? 'Qualified' : 'Below tier'}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {activeTab === 'steering' && (
          <div className="two-column steering-layout">
            <section className="panel">
              <div className="panel-heading compact">
                <div>
                  <h3>Active weights</h3>
                  <p>Current community inputs applied to the decision cycle.</p>
                </div>
              </div>
              <div className="weights-grid">
                <div>
                  <span>Underdog bias</span>
                  <strong>{formatNumber(steeringStatus?.underdog_bias, 2)}x</strong>
                </div>
                <div>
                  <span>NCAAF weight</span>
                  <strong>{formatNumber(steeringStatus?.ncaaf_weight, 2)}x</strong>
                </div>
                <div>
                  <span>NFL weight</span>
                  <strong>{formatNumber(steeringStatus?.nfl_weight, 2)}x</strong>
                </div>
                <div>
                  <span>Min edge</span>
                  <strong>{formatNumber(steeringStatus?.min_edge_threshold)} pts</strong>
                </div>
                <div className="directive-box">
                  <span>Directive</span>
                  <strong>{steeringStatus?.custom_directive ?? 'Default strategy'}</strong>
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="panel-heading compact">
                <div>
                  <h3>Submit steering burn</h3>
                  <p>Qualified holders can burn tokens to adjust weights.</p>
                </div>
              </div>
              <form className="steer-form" onSubmit={handleSteerSubmit}>
                <label>
                  <span>Holder wallet</span>
                  <input onChange={(event) => setSteerAddress(event.target.value)} required type="text" value={steerAddress} />
                </label>
                <label>
                  <span>Tokens to burn</span>
                  <input
                    min={50000}
                    onChange={(event) => setSteerBurnTokens(Number(event.target.value))}
                    step={10000}
                    type="number"
                    value={steerBurnTokens}
                  />
                </label>
                <div className="slider-group">
                  <label>
                    <span>Underdog bias {formatNumber(steerUnderdogBias, 2)}x</span>
                    <input max="2" min="0.5" onChange={(event) => setSteerUnderdogBias(Number(event.target.value))} step="0.05" type="range" value={steerUnderdogBias} />
                  </label>
                  <label>
                    <span>NCAAF weight {formatNumber(steerNcaafWeight, 2)}x</span>
                    <input max="2" min="0.5" onChange={(event) => setSteerNcaafWeight(Number(event.target.value))} step="0.05" type="range" value={steerNcaafWeight} />
                  </label>
                  <label>
                    <span>NFL weight {formatNumber(steerNflWeight, 2)}x</span>
                    <input max="2" min="0.5" onChange={(event) => setSteerNflWeight(Number(event.target.value))} step="0.05" type="range" value={steerNflWeight} />
                  </label>
                  <label>
                    <span>Minimum edge {formatNumber(steerMinEdge)} pts</span>
                    <input max="4" min="0.5" onChange={(event) => setSteerMinEdge(Number(event.target.value))} step="0.1" type="range" value={steerMinEdge} />
                  </label>
                </div>
                <label>
                  <span>Strategy directive</span>
                  <textarea onChange={(event) => setSteerDirective(event.target.value)} rows={4} value={steerDirective} />
                </label>
                <button className="primary" type="submit">Burn and apply weights</button>
              </form>
              {steerMessage && <div className="notice compact-notice">{steerMessage}</div>}
            </section>
          </div>
        )}
      </section>
    </main>
  )
}

export default App
