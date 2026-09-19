import { useEffect, useMemo, useState } from 'react'

type SportLabel = 'ALL' | 'NFL' | 'NCAAF'

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

const emptyBoard: BoardResponse = {
  generated_at: new Date().toISOString(),
  source: 'preview',
  status: 'Loading market board...',
  rows: [],
}

function formatDate(value: string | null) {
  if (!value) return '-'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatNumber(value: number | null, digits = 1) {
  return value === null || !Number.isFinite(value) ? '-' : value.toFixed(digits)
}

function formatCents(value: number | null) {
  return value === null || !Number.isFinite(value) ? '-' : `${Math.round(value * 100)}c`
}

function formatVolume(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return value >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : value.toFixed(0)
}

function formatWeather(row: BoardRow) {
  const weather = row.bluechip?.weather
  if (!weather?.condition) return '-'
  const temp = weather.temperature_f === null ? '' : `, ${formatNumber(weather.temperature_f, 0)}F`
  const wind = weather.wind_mph === null ? '' : `, ${formatNumber(weather.wind_mph, 0)} mph`
  return `${weather.condition}${temp}${wind}`
}

function formatWeatherImpact(row: BoardRow) {
  const impact = row.weather_impact
  if (!impact) return 'Weather model -'
  const total = impact.adjusted_total === null ? `total ${formatNumber(impact.total_adjustment)}` : `total ${formatNumber(impact.adjusted_total)}`
  return `${impact.category} ${formatNumber(impact.score, 0)}/100, ${total}, conf ${formatNumber(impact.confidence, 0)}`
}

function marketTypeLabel(row: BoardRow) {
  return row.bet_type === 'total' ? 'Over/under' : 'Spread'
}

function breakdownLine(row: BoardRow) {
  const price = `${formatCents(row.contract?.yes_bid ?? null)} / ${formatCents(row.contract?.yes_ask ?? null)}`
  const model = row.bluechip?.model_line ? `BC ${row.bluechip.model_line}, gap ${formatNumber(row.bluechip.gap)}` : 'No BC model'
  return `${marketTypeLabel(row)}: ${consensusLabel(row)} | ${price} | ${model}`
}

function consensusLabel(row: BoardRow) {
  if (row.data_source === 'kalshi' && row.contract) {
    const strike = row.market.consensus_spread
    const spread = strike === null ? '' : ` > ${formatNumber(strike)}`
    return `${row.contract.side_label ?? row.contract.title}${spread}`
  }
  const spread = row.market.consensus_spread
  if (spread === null) return '-'
  if (spread < 0) return `${row.home_team} ${spread.toFixed(1)}`
  if (spread > 0) return `${row.away_team} ${(-spread).toFixed(1)}`
  return 'Pick'
}

async function fetchBoard(): Promise<BoardResponse> {
  try {
    const response = await fetch('/api/board', { cache: 'no-store' })
    if (!response.ok) throw new Error('API unavailable')
    return (await response.json()) as BoardResponse
  } catch {
    const response = await fetch('/data/board-preview.json', { cache: 'no-store' })
    if (!response.ok) return emptyBoard
    return { ...((await response.json()) as BoardResponse), source: 'preview' }
  }
}

function App() {
  const [board, setBoard] = useState<BoardResponse>(emptyBoard)
  const [selectedSport, setSelectedSport] = useState<SportLabel>('ALL')
  const [sortMode, setSortMode] = useState('cover')
  const [selectedGameId, setSelectedGameId] = useState('')
  const [teamSearch, setTeamSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let active = true

    async function refresh(showRefreshing = false) {
      if (showRefreshing) setRefreshing(true)
      const nextBoard = await fetchBoard()
      if (!active) return
      setBoard(nextBoard)
      if (showRefreshing) setRefreshing(false)
    }

    void refresh(true)
    const timer = window.setInterval(() => {
      void refresh()
    }, 60000)

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const rows = useMemo(() => {
    const sportRows =
      selectedSport === 'ALL' ? board.rows : board.rows.filter((row) => row.sport === selectedSport)
    const query = teamSearch.trim().toLowerCase()
    const searchedRows = query
      ? sportRows.filter((row) =>
          `${row.away_team} ${row.home_team} ${row.contract?.title ?? ''}`.toLowerCase().includes(query),
        )
      : sportRows
    return [...searchedRows].sort((a, b) => {
      if (sortMode === 'cover') return (b.edge_score ?? 0) - (a.edge_score ?? 0)
      if (sortMode === 'move') {
        return Math.abs(b.metrics.line_move ?? 0) - Math.abs(a.metrics.line_move ?? 0)
      }
      if (sortMode === 'volume') return (b.contract?.volume_24h ?? 0) - (a.contract?.volume_24h ?? 0)
      if (sortMode === 'interest') return (b.contract?.open_interest ?? 0) - (a.contract?.open_interest ?? 0)
      if (sortMode === 'books') return b.market.book_count - a.market.book_count
      return Math.abs(b.metrics.model_market_gap ?? 0) - Math.abs(a.metrics.model_market_gap ?? 0)
    })
  }, [board.rows, selectedSport, sortMode, teamSearch])

  const selectedRow = rows.find((row) => row.game_id === selectedGameId) ?? rows[0] ?? null
  const topEdge = rows[0]?.edge_score ?? null
  const latestUpdate = rows.reduce<string | null>((latest, row) => {
    if (!latest) return row.updated_at
    return new Date(row.updated_at) > new Date(latest) ? row.updated_at : latest
  }, null)
  const liveLabel = board.source === 'kalshi' ? 'Kalshi live' : board.source === 'preview' ? 'Preview feed' : 'Live feed'

  return (
    <main className="shell">
      <aside className="sidebar" aria-label="Controls">
        <div className="brand">
          <span className="brand-mark">MB</span>
          <div>
            <p>MarkBets</p>
            <h1>Coverage Desk</h1>
          </div>
        </div>

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

        <label className="field">
          <span>Rank by</span>
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value)}>
            <option value="cover">Best cover odds</option>
            <option value="gap">Model gap</option>
            <option value="move">Price move</option>
            <option value="volume">24h volume</option>
            <option value="interest">Open interest</option>
            <option value="books">Book count</option>
          </select>
        </label>

        <div className="data-source">
          <span>Live feed</span>
          <strong>{liveLabel}</strong>
          <small>{refreshing ? 'Updating now' : `Auto-refreshes every minute`}</small>
          <small>{rows.length.toLocaleString()} markets</small>
        </div>
      </aside>

      <section className="content">
        <div className="topbar">
          <div>
            <p className="eyebrow">Live market board</p>
            <h2>Best spread and total edges</h2>
          </div>
          <div className="live-state">
            <span>{board.source === 'preview' ? 'Preview' : 'Live'}</span>
            <strong>{latestUpdate ? formatDate(latestUpdate) : 'Loading'}</strong>
          </div>
        </div>

        <section className="metrics" aria-label="Summary">
          <div>
            <span>Markets</span>
            <strong>{rows.length.toLocaleString()}</strong>
          </div>
          <div>
            <span>Top edge</span>
            <strong>{formatNumber(topEdge)}</strong>
          </div>
          <div>
            <span>Last update</span>
            <strong>{latestUpdate ? formatDate(latestUpdate) : '-'}</strong>
          </div>
          <div>
            <span>Source</span>
            <strong>{board.source}</strong>
          </div>
        </section>

        <section className="detail-grid">
          {selectedRow ? (
            <>
              <div className="detail-main">
                <p className="eyebrow">{selectedRow.sport}</p>
                <h3>{selectedRow.contract?.title ?? `${selectedRow.away_team} at ${selectedRow.home_team}`}</h3>
                <p className="team-breakdown">
                  {selectedRow.away_team} vs {selectedRow.home_team}
                  <br />
                  {breakdownLine(selectedRow)}
                  <br />
                  {formatWeather(selectedRow)} / {formatWeatherImpact(selectedRow)}
                </p>
                <div className="line-chart" aria-label="Opening to current line">
                  <span>Prev {formatCents(selectedRow.contract?.previous_price ?? selectedRow.market.opening_spread)}</span>
                  <strong>Last {formatCents(selectedRow.contract?.last_price ?? selectedRow.market.consensus_spread)}</strong>
                  <span>Move {formatNumber(selectedRow.metrics.line_move)}</span>
                </div>
              </div>
              <div className="detail-stack">
                <div>
                  <span>Bid / ask</span>
                  <strong>
                    {formatCents(selectedRow.contract?.yes_bid ?? null)} / {formatCents(selectedRow.contract?.yes_ask ?? null)}
                  </strong>
                  <small>{selectedRow.market.latest_book ?? '-'}; {formatDate(selectedRow.market.latest_timestamp)}</small>
                </div>
                <div>
                  <span>Blue Chip model</span>
                  <strong>{selectedRow.bluechip?.model_line ?? '-'}</strong>
                  <small>
                    {selectedRow.bluechip?.market_line ?? 'No market line'}; gap{' '}
                    {formatNumber(selectedRow.bluechip?.gap ?? selectedRow.metrics.model_market_gap)}
                  </small>
                </div>
                <div>
                  <span>Weather impact</span>
                  <strong>{selectedRow.weather_impact ? `${selectedRow.weather_impact.category} ${formatNumber(selectedRow.weather_impact.score, 0)}/100` : '-'}</strong>
                  <small>
                    Total {formatNumber(selectedRow.weather_impact?.total_adjustment ?? null)}; confidence{' '}
                    {formatNumber(selectedRow.weather_impact?.confidence ?? null, 0)}
                  </small>
                </div>
                <div>
                  <span>Activity</span>
                  <strong>{formatVolume(selectedRow.contract?.volume_24h)}</strong>
                  <small>24h volume, {formatVolume(selectedRow.contract?.open_interest)} open interest</small>
                </div>
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
              <p>Select a row to update the market breakdown above.</p>
            </div>
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
                  <span>
                    <strong>
                      {row.away_team} vs {row.home_team}
                    </strong>
                    <small>
                      {row.sport} / {marketTypeLabel(row)} / {formatDate(row.commence_time)}
                    </small>
                  </span>
                  <span className="line-copy">{breakdownLine(row)}</span>
                  <span className="line-copy muted">{formatWeather(row)} / {formatWeatherImpact(row)} / vol {formatVolume(row.contract?.volume_24h)}</span>
                </button>
              ))
            ) : (
              <div className="empty">No live markets match that search.</div>
            )}
          </div>
        </section>

      </section>
    </main>
  )
}

export default App
