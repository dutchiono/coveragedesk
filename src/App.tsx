import { useEffect, useMemo, useState, type FormEvent } from 'react'

type SportLabel = 'ALL' | 'SPORTS' | 'NCAAF' | 'NFL' | 'FINANCIALS' | 'ECONOMICS' | 'POLITICS' | 'TECH' | 'CULTURE'
type TabName = 'board' | 'agent' | 'tokenomics' | 'steering'
const REFRESH_MS = 5 * 60 * 1000

function getBrandInfo() {
  const hostname = typeof window !== 'undefined' ? window.location.hostname.toLowerCase() : ''
  if (hostname.includes('lineedge')) {
    return {
      name: 'LineEdge',
      mark: 'LE',
      symbol: 'LINE',
      domain: 'lineedge.online',
      title: 'LineEdge | Agentic Sports Spread Protocol',
    }
  }
  return {
    name: 'CoverageDesk',
    mark: 'CD',
    symbol: 'CVR',
    domain: 'coveragedesk.online',
    title: 'CoverageDesk | Autonomous AI Sports Spread Protocol',
  }
}

type BoardRow = {
  game_id: string
  data_source?: 'sportsbook' | 'kalshi'
  sport: string
  category?: string
  raw_category?: string
  is_arb?: boolean
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
  rating?: {
    grade: string
    edge: number
    summary: string
    explanation: string
    gap_points: number
    price_edge_cents: number
  }
  steering?: SteeringStatus | null
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
  enabled?: boolean
  contract_address?: string | null
  token_symbol?: string | null
  message?: string
  total_supply?: number
  bankroll_balance?: number
  total_fees_collected?: number
  total_burned?: number
  total_distributed?: number
  total_wins?: number
  total_losses?: number
  win_rate?: number
  updated_at?: string
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

function localDateKey(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function todayDateKey(): string {
  return localDateKey(new Date().toISOString()) ?? ''
}

function formatSlateKey(key: string | null): string {
  if (!key) return 'No slate'
  const date = new Date(`${key}T12:00:00`)
  if (Number.isNaN(date.getTime())) return key
  const today = todayDateKey()
  if (key === today) return 'Today'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

function targetSlateKey(rows: BoardRow[]): string | null {
  const keys = rows
    .map((row) => localDateKey(row.commence_time))
    .filter((key): key is string => Boolean(key))
    .sort()
  if (!keys.length) return null

  const today = todayDateKey()
  if (keys.includes(today)) return today
  return keys.find((key) => key > today) ?? keys[0]
}

function formatNumber(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits)
}

function formatSigned(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`
}

function formatTokenAmount(value: number | null | undefined, symbol = 'LINE'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${symbol.replace(/^\$/, '')}`
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

function isModeled(row: BoardRow): boolean {
  return modelGap(row) !== null && row.rating?.summary !== 'Unmodeled market'
}

function gameTitle(row: BoardRow): string {
  if (row.sport === 'NCAAF' || row.sport === 'NFL' || (row.away_team.includes(' at ') || row.home_team.includes(' at '))) {
    return `${row.away_team} at ${row.home_team}`
  }
  return row.contract?.title ?? row.away_team
}

function ratingLabel(row: BoardRow): string {
  if (row.is_arb) return '⚡ Orderbook Arb'
  if (!isModeled(row)) return row.category ?? row.raw_category ?? 'Kalshi'
  if (!row.rating) return 'Model'
  return row.rating?.grade ?? 'Fair'
}

function ratingValue(row: BoardRow): string {
  if (row.is_arb && row.contract) return `${row.contract.yes_bid ?? 0}c / ${row.contract.no_bid ?? 0}c`
  if (!isModeled(row)) return row.contract?.yes_bid ? `${row.contract.yes_bid}c` : 'Market'
  const cents = row.rating?.price_edge_cents
  if (cents !== null && cents !== undefined && Number.isFinite(cents) && Math.abs(cents) >= 0.1) {
    return `${cents > 0 ? '+' : ''}${cents.toFixed(1)}c`
  }
  return formatSigned(modelGap(row))
}

function ratingClass(row: BoardRow): string {
  if (row.is_arb) return 'prime'
  if (!isModeled(row)) return 'lean'
  const grade = (row.rating?.grade ?? 'Even').toLowerCase().replace(/\s+/g, '-')
  if (grade.includes('strong-buy')) return 'prime'
  if (grade === 'buy') return 'strong'
  if (grade.includes('avoid')) return 'avoid'
  return 'lean'
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
  const brand = useMemo(() => getBrandInfo(), [])
  const [activeTab, setActiveTab] = useState<TabName>('board')
  const [board, setBoard] = useState<BoardResponse>(emptyBoard)
  const [selectedSport, setSelectedSport] = useState<SportLabel>('NCAAF')
  const [teamSearch, setTeamSearch] = useState('')
  const [showAllGames, setShowAllGames] = useState(false)
  const [selectedGameId, setSelectedGameId] = useState<string>('')
  const [refreshing, setRefreshing] = useState(false)

  const [agentThoughts, setAgentThoughts] = useState<AgentThought[]>([])
  const [agentBets, setAgentBets] = useState<AgentBet[]>([])
  const [tokenStats, setTokenStats] = useState<TokenStats | null>(null)
  const [holders, setHolders] = useState<Holder[]>([])

  const [steerAddress, setSteerAddress] = useState('')
  const [steerBurnTokens, setSteerBurnTokens] = useState(0)
  const [steerUnderdogBias, setSteerUnderdogBias] = useState(1)
  const [steerNcaafWeight, setSteerNcaafWeight] = useState(1)
  const [steerNflWeight, setSteerNflWeight] = useState(1)
  const [steerMinEdge, setSteerMinEdge] = useState(1.5)
  const [steerDirective, setSteerDirective] = useState('')
  const [steerMessage, setSteerMessage] = useState<string | null>(null)
  const [legalModal, setLegalModal] = useState<'tos' | 'privacy' | 'risk' | null>(null)

  useEffect(() => {
    document.title = brand.title
  }, [brand.title])

  async function loadData(showRefreshing = true) {
    if (showRefreshing) setRefreshing(true)
    try {
      const [boardRes, thoughtsRes, betsRes, statsRes, holdersRes] = await Promise.all([
        fetchBoard(),
        fetch('/api/agent/thoughts').then((response) => response.json()).catch(() => ({ thoughts: [] })),
        fetch('/api/agent/bets').then((response) => response.json()).catch(() => ({ bets: [] })),
        fetch('/api/agent/token-stats').then((response) => response.json()).catch(() => null),
        fetch('/api/agent/holders').then((response) => response.json()).catch(() => ({ holders: [] })),
      ])

      if (boardRes && Array.isArray(boardRes.rows)) setBoard(boardRes)
      if (thoughtsRes && Array.isArray(thoughtsRes.thoughts)) setAgentThoughts(thoughtsRes.thoughts)
      if (betsRes && Array.isArray(betsRes.bets)) setAgentBets(betsRes.bets)
      if (statsRes) setTokenStats(statsRes)
      if (holdersRes && Array.isArray(holdersRes.holders)) setHolders(holdersRes.holders)
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

  async function handleSteerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSteerMessage('Submitting steering burn...')
    try {
      const response = await fetch('/api/agent/steer-game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          game_id: selectedRow?.game_id,
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
        setSteerMessage(`Burn accepted: ${formatTokenAmount(steerBurnTokens, tokenStats?.token_symbol ?? brand.symbol)} committed to this market.`)
        await loadData()
      } else {
        setSteerMessage(`Steering rejected: ${response.detail || 'holder is not qualified.'}`)
      }
    } catch {
      setSteerMessage('Steering endpoint unavailable.')
    }
  }

  const baseRows = useMemo(() => {
    return board.rows
      .filter((row) => {
        if (selectedSport === 'ALL') return true
        if (selectedSport === 'SPORTS') return row.sport === 'SPORTS' || row.sport === 'NCAAF' || row.sport === 'NFL' || row.category === 'SPORTS'
        return row.sport === selectedSport || row.category === selectedSport
      })
      .filter((row) => rowMatches(row, teamSearch))
  }, [board.rows, selectedSport, teamSearch])

  const slateKey = useMemo(() => targetSlateKey(baseRows), [baseRows])

  const rows = useMemo(() => {
    return baseRows
      .filter((row) => showAllGames || (selectedSport !== 'SPORTS' && selectedSport !== 'NCAAF' && selectedSport !== 'NFL') || localDateKey(row.commence_time) === slateKey)
      .sort((a, b) => {
        const aArb = a.is_arb ? 1 : 0
        const bArb = b.is_arb ? 1 : 0
        if (aArb !== bArb) return bArb - aArb
        const aModeled = isModeled(a) ? 1 : 0
        const bModeled = isModeled(b) ? 1 : 0
        if (aModeled !== bModeled) return bModeled - aModeled
        const aEdge = a.edge_score ?? Math.abs(modelGap(a) ?? 0) * 20
        const bEdge = b.edge_score ?? Math.abs(modelGap(b) ?? 0) * 20
        return bEdge - aEdge || Math.abs(modelGap(b) ?? 0) - Math.abs(modelGap(a) ?? 0)
      })
  }, [baseRows, selectedSport, showAllGames, slateKey])

  const selectedRow = rows.find((row) => row.game_id === selectedGameId) ?? rows[0] ?? null
  const openBets = agentBets.filter((bet) => bet.status === 'OPEN').length
  const settledBets = agentBets.length - openBets
  const topGap = rows.reduce<number | null>((largest, row) => {
    const gap = Math.abs(modelGap(row) ?? 0)
    if (!gap) return largest
    return largest === null || gap > largest ? gap : largest
  }, null)
  const protocolEnabled = tokenStats?.enabled === true
  const tokenSymbol = tokenStats?.token_symbol ?? brand.symbol
  const modeledCount = rows.filter(isModeled).length
  const slateLabel = showAllGames ? 'All dates' : formatSlateKey(slateKey)

  useEffect(() => {
    if (!protocolEnabled && (activeTab === 'tokenomics' || activeTab === 'steering')) {
      setActiveTab('board')
    }
  }, [activeTab, protocolEnabled])

  return (
    <main className="shell">
      <aside className="sidebar" aria-label={`${brand.name} controls`}>
        <div className="brand">
          <span className="brand-mark">{brand.mark}</span>
          <div>
            <p>{brand.name}</p>
            <h1>Spread Protocol</h1>
          </div>
        </div>

        <nav className="tab-nav" aria-label="Primary views">
          {[
            ['board', 'Board'],
            ['agent', `Agent ${agentBets.length}`],
            ...(protocolEnabled ? [
              ['tokenomics', 'Token'],
              ['steering', 'Steering'],
            ] : []),
          ].map(([tab, label]) => (
            <button className={activeTab === tab ? 'active' : ''} key={tab} onClick={() => setActiveTab(tab as TabName)} type="button">
              {label}
            </button>
          ))}
        </nav>

        {activeTab === 'board' && (
          <>
            <label className="field">
              <span>Market search</span>
              <input
                onChange={(event) => setTeamSearch(event.target.value)}
                placeholder="Search market or team"
                type="search"
                value={teamSearch}
              />
            </label>

            <div className="field-group">
              <label className="field">
                <span>Category filter</span>
                <select onChange={(event) => setSelectedSport(event.target.value as SportLabel)} value={selectedSport}>
                  <option value="ALL">⚡ All Categories</option>
                  <option value="SPORTS">🏈 Sports Markets</option>
                  <option value="FINANCIALS">📈 Crypto & Financials</option>
                  <option value="ECONOMICS">🏛️ Macro & Economics</option>
                  <option value="POLITICS">🗳️ Politics & Elections</option>
                  <option value="TECH">🔬 Tech, AI & Climate</option>
                  <option value="CULTURE">🎭 Culture & Entertainment</option>
                </select>
              </label>

              <label className="checkbox-field">
                <input
                  checked={showAllGames}
                  onChange={(event) => setShowAllGames(event.target.checked)}
                  type="checkbox"
                />
                <span>Include all dates</span>
              </label>
            </div>
          </>
        )}

        <div className="side-meta">
          <span>Feed status</span>
          <strong>{refreshing ? 'Refreshing...' : 'Live'}</strong>
          <small>{slateLabel}</small>
          <small>{board.source === 'preview' ? 'Preview feed' : board.source === 'kalshi' ? 'Kalshi feed' : 'Sportsbook feed'}</small>
        </div>

        {protocolEnabled && (
          <div className="side-ledger">
            <span>{tokenSymbol} contract</span>
            <strong>{compactAddress(tokenStats?.contract_address ?? '')}</strong>
            <small>Burned {formatTokenAmount(tokenStats?.total_burned, tokenSymbol)}</small>
            <small>Paid {formatTokenAmount(tokenStats?.total_distributed, tokenSymbol)}</small>
          </div>
        )}
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">coveragedesk.online</p>
            <h2>
              {activeTab === 'board' && `${selectedSport === 'ALL' ? 'All Kalshi & Sports' : selectedSport} board`}
              {activeTab === 'agent' && 'Agent ledger'}
              {activeTab === 'tokenomics' && 'Token ledger'}
              {activeTab === 'steering' && 'Holder steering'}
            </h2>
            <p className="board-meta">
              {activeTab === 'board' && `${rows.length.toLocaleString()} markets | ${slateLabel} | ${modeledCount.toLocaleString()} modeled | Top gap ${formatSigned(topGap)} | Updated ${formatDate(board.generated_at)}`}
              {activeTab === 'agent' && `${openBets} open wagers | ${settledBets} settled | ${agentThoughts.length} market reads`}
              {activeTab === 'tokenomics' && `${formatTokenAmount(tokenStats?.total_supply, tokenSymbol)} supply | ${formatPercent(tokenStats?.win_rate, 0)} win rate`}
              {activeTab === 'steering' && `${selectedRow ? gameTitle(selectedRow) : 'Select a market'} | ${tokenSymbol} enabled`}
            </p>
          </div>
        </header>



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
                <span>Modeled</span>
                <strong>{modeledCount.toLocaleString()}</strong>
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
                        <h3>{gameTitle(selectedRow)}</h3>
                        <p>{selectedRow.contract?.title ?? consensusLabel(selectedRow)}</p>
                      </div>
                      <div className={`ticket-rating ${ratingClass(selectedRow)}`}>
                        <span>{ratingLabel(selectedRow)}</span>
                        <strong>{ratingValue(selectedRow)}</strong>
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
                      <span>Market read</span>
                      <strong>{isModeled(selectedRow) ? (selectedRow.rating?.summary ?? 'Modeled edge') : 'No model benchmark'}</strong>
                      <small>{isModeled(selectedRow) ? (selectedRow.rating?.explanation ?? `Model gap ${formatSigned(modelGap(selectedRow))}`) : 'Hidden from rating math until Blue Chip/model data exists.'}</small>
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
                        <strong>{gameTitle(row)}</strong>
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
                        <span className={`rating-pill ${ratingClass(row)}`}>
                          <strong>{ratingLabel(row)}</strong>
                          <span>{ratingValue(row)}</span>
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
                  <h3>{protocolEnabled ? 'Bet ledger' : 'Execution disabled'}</h3>
                  <p>{protocolEnabled ? 'Settled wins split profit between burns and qualified holders.' : 'Add the token CA before LineEdge can track bankroll wagers, burns, or payouts.'}</p>
                </div>
              </div>
              <div className="ledger-list">
                {!protocolEnabled ? <div className="empty">Read-only market mode. No token bankroll is configured.</div> : agentBets.length ? agentBets.map((bet) => (
                  <article className="ledger-row" key={bet.id}>
                    <div>
                      <strong>{bet.matchup}</strong>
                      <small>{bet.bet_side} / {bet.sport}</small>
                    </div>
                    <span>{formatTokenAmount(bet.stake, tokenSymbol)}</span>
                    <span className={`status-badge ${bet.status.toLowerCase()}`}>{bet.status}</span>
                    <span>{formatTokenAmount(bet.buyback_burned, tokenSymbol)}</span>
                    <span>{formatTokenAmount(bet.dividend_distributed, tokenSymbol)}</span>
                  </article>
                )) : <div className="empty">No bets recorded yet.</div>}
              </div>
            </section>
          </div>
        )}

        {activeTab === 'tokenomics' && protocolEnabled && (
          <div className="tokenomics-layout">
            <section className="metrics">
              <div>
                <span>Total supply</span>
                <strong>{formatTokenAmount(tokenStats?.total_supply, tokenSymbol)}</strong>
              </div>
              <div>
                <span>Bankroll</span>
                <strong>{formatTokenAmount(tokenStats?.bankroll_balance, tokenSymbol)}</strong>
              </div>
              <div>
                <span>Total burned</span>
                <strong>{formatTokenAmount(tokenStats?.total_burned, tokenSymbol)}</strong>
              </div>
              <div>
                <span>Holder payouts</span>
                <strong>{formatTokenAmount(tokenStats?.total_distributed, tokenSymbol)}</strong>
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
                    <span>{formatTokenAmount(holder.balance, tokenSymbol)}</span>
                    <span>{holder.percentage.toFixed(2)}%</span>
                    <span className={holder.is_dividend_eligible ? 'yes' : 'no'}>{holder.is_dividend_eligible ? 'Qualified' : 'Below tier'}</span>
                    <span className={holder.is_steering_eligible ? 'yes' : 'no'}>{holder.is_steering_eligible ? 'Qualified' : 'Below tier'}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {activeTab === 'steering' && protocolEnabled && (
          <div className="two-column steering-layout">

            <section className="panel">
              <div className="panel-heading compact">
                <div>
                  <h3>Selected market steering</h3>
                  <p>{selectedRow ? `${selectedRow.away_team} at ${selectedRow.home_team}` : 'Select a market on the board first.'}</p>
                </div>
              </div>
              {selectedRow?.steering ? (
                <div className="weights-grid">
                  <div>
                    <span>Underdog bias</span>
                    <strong>{formatNumber(selectedRow.steering.underdog_bias, 2)}x</strong>
                  </div>
                  <div>
                    <span>NCAAF weight</span>
                    <strong>{formatNumber(selectedRow.steering.ncaaf_weight, 2)}x</strong>
                  </div>
                  <div>
                    <span>NFL weight</span>
                    <strong>{formatNumber(selectedRow.steering.nfl_weight, 2)}x</strong>
                  </div>
                  <div>
                    <span>Min edge</span>
                    <strong>{formatNumber(selectedRow.steering.min_edge_threshold)} pts</strong>
                  </div>
                  <div className="directive-box">
                    <span>Directive</span>
                    <strong>{selectedRow.steering.custom_directive || 'No directive text'}</strong>
                  </div>
                </div>
              ) : (
                <div className="empty">No steering burn has been recorded for this market.</div>
              )}
            </section>

            <section className="panel">
              <div className="panel-heading compact">
                <div>
                  <h3>Submit steering burn</h3>
                  <p>Qualified holders can burn real {tokenSymbol} to adjust this selected market.</p>
                </div>
              </div>
              <form className="steer-form" onSubmit={handleSteerSubmit}>
                <label>
                  <span>Holder wallet</span>
                  <input onChange={(event) => setSteerAddress(event.target.value)} placeholder="Wallet address" required type="text" value={steerAddress} />
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
                <button className="primary" disabled={!selectedRow} type="submit">Burn and apply to selected market</button>
              </form>
              {steerMessage && <div className="notice compact-notice">{steerMessage}</div>}
            </section>
          </div>
        )}


      <footer className="site-footer">

        <div className="footer-main">
          <div className="footer-brand">
            <h4>LineEdge</h4>
            <p>Autonomous AI sports spread agent, tokenomics ledger, and holder steering engine for crypto sports prediction markets.</p>
            <div className="social-nav-links">
              <a href="https://x.com/coveragedesk_" target="_blank" rel="noopener noreferrer">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                </svg>
                X / Twitter
              </a>
              <a href="https://t.me/coveragedesk" target="_blank" rel="noopener noreferrer">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
                </svg>
                Telegram
              </a>
            </div>
          </div>
          <div className="footer-col">
            <h5>Navigation</h5>
            <div className="footer-links">
              <a href="#lines" onClick={() => setActiveTab('board')}>Spread Lines</a>
              <a href="#agent" onClick={() => setActiveTab('agent')}>Agent Ledger</a>
              <a href="#tokenomics" onClick={() => setActiveTab('tokenomics')}>Tokenomics & Holders</a>
              <a href="#steering" onClick={() => setActiveTab('steering')}>Holder Steering</a>
            </div>
          </div>
          <div className="footer-col">
            <h5>Legal & Risk</h5>
            <div className="footer-links">
              <button type="button" onClick={() => setLegalModal('tos')}>Terms of Service</button>
              <button type="button" onClick={() => setLegalModal('privacy')}>Privacy Policy</button>
              <button type="button" onClick={() => setLegalModal('risk')}>Risk Disclosure</button>
            </div>
          </div>
          <div className="footer-col">
            <h5>Token</h5>
            <div className="footer-links">
              <span>Token Name: <strong>{brand.name}</strong></span>
              <span>Ticker: <strong>${brand.symbol}</strong></span>
              <span>Burn Pool: <strong>50%</strong> Net Profit</span>
              <span>Dividends: <strong>50%</strong> to &gt;1% Holders</span>
            </div>
          </div>

        </div>
        <div className="footer-bottom">
          <span>&copy; {new Date().getFullYear()} {brand.name}. All rights reserved.</span>
          <span>Powered by {brand.name} Agent Engine</span>
        </div>
      </footer>
      </section>


      {legalModal && (
        <div className="dialog-backdrop" onClick={() => setLegalModal(null)}>
          <div className="dialog-card legal-dialog-card" onClick={(e) => e.stopPropagation()}>
            <header className="dialog-header">
              <div>
                <h3>
                  {legalModal === 'tos' && 'Terms of Service'}
                  {legalModal === 'privacy' && 'Privacy Policy'}
                  {legalModal === 'risk' && 'Risk Disclosure & Disclaimer'}
                </h3>
                <p>{brand.name} Protocol Legal Guidelines</p>
              </div>
              <button className="icon-button" type="button" onClick={() => setLegalModal(null)}>✕</button>
            </header>
            <div className="dialog-body legal-content">
              {legalModal === 'tos' && (
                <>
                  <h4>1. Acceptance of Terms</h4>
                  <p>By accessing or using {brand.name} ({brand.domain}), you agree to be bound by these Terms of Service. If you do not agree, do not access or use the platform.</p>
                  <h4>2. Experimental AI & Prediction Markets</h4>
                  <p>{brand.name} operates an autonomous AI decision agent that tracks sports spreads and prediction market pricing. All analytics, ratings, models, and automated transactions are provided on an experimental basis for informational and steering purposes.</p>
                  <h4>3. Tokenomics (${brand.symbol}) & Holder Steering</h4>
                  <p>${brand.symbol} utility tokens allow holders with &ge;0.5% supply to participate in line-weighting steering by burning tokens. 50% of simulated net agent profits are directed to automatic token buyback & burn, and 50% are distributed to qualified holders (&gt;1% supply).</p>
                  <h4>4. No Financial Advice</h4>
                  <p>Content, models, and predictions produced by {brand.name} do not constitute financial, investment, or gambling advice. Always conduct your own research.</p>
                </>
              )}

              {legalModal === 'privacy' && (
                <>
                  <h4>1. Data Collection</h4>
                  <p>LineEdge does not collect personally identifiable information (PII). We do not require accounts, email addresses, or passwords.</p>
                  <h4>2. Blockchain & Wallet Data</h4>
                  <p>Public wallet addresses provided during holder steering or dividend verification are stored in public/on-chain ledgers and indexed by the backend for tokenomics calculations.</p>
                  <h4>3. Analytics & Local Storage</h4>
                  <p>Minimal local storage may be utilized by your web browser to save user UI preferences and current filter selections.</p>
                </>
              )}

              {legalModal === 'risk' && (
                <>
                  <h4>1. Cryptocurrency Risk</h4>
                  <p>Digital assets, including $LINE, carry significant price volatility and risk of total loss. Crypto tokens are not insured by any government entity.</p>
                  <h4>2. Autonomous Agent Risk</h4>
                  <p>The AI betting engine relies on automated scrapers, models, and algorithms. Model predictions can be inaccurate, incomplete, or delayed due to market conditions or data provider outages.</p>
                  <h4>3. Regulatory Compliance</h4>
                  <p>Users are responsible for ensuring that participating in prediction market tools, token steering, or sports analytics complies with local laws in their jurisdiction.</p>
                </>
              )}
            </div>
            <footer className="dialog-actions">
              <button className="primary" type="button" onClick={() => setLegalModal(null)}>Close</button>
            </footer>
          </div>
        </div>
      )}

    </main>
  )
}

export default App
