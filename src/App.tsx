import { useEffect, useMemo, useState } from 'react'

type SportLabel = 'ALL' | 'NFL' | 'NCAAF'
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

function formatSigned(value: number | null, digits = 1) {
  if (value === null || !Number.isFinite(value)) return '-'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`
}

function coverOdds(row: BoardRow) {
  return row.contract?.last_price ?? row.contract?.yes_bid ?? row.contract?.yes_ask ?? null
}

function modelGap(row: BoardRow) {
  return row.bluechip?.gap ?? row.metrics.model_market_gap ?? null
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
  if (!impact || Math.abs(impact.total_adjustment) < 0.1) return null
  const total = impact.adjusted_total === null ? 'total lean' : `adjusted total ${formatNumber(impact.adjusted_total)}`
  return `Weather ${total} (${formatSigned(impact.total_adjustment)} pts)`
}

function marketTypeLabel(row: BoardRow) {
  return row.bet_type === 'total' ? 'Over/under' : 'Spread'
}

function breakdownLine(row: BoardRow) {
  const model = row.bluechip?.model_line ? `Model ${row.bluechip.model_line}; gap ${formatSigned(modelGap(row))}` : 'Model gap unavailable'
  return `${marketTypeLabel(row)}: ${consensusLabel(row)} | odds ${formatCents(coverOdds(row))} | ${model}`
}

function confidenceLabel(score: number) {
  if (score >= 84) return 'Strong'
  if (score >= 72) return 'Good'
  if (score >= 62) return 'Moderate'
  return 'Thin'
}

function confidenceClass(score: number) {
  return confidenceLabel(score).toLowerCase()
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
    }, REFRESH_MS)

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
      return Math.abs(modelGap(b) ?? 0) - Math.abs(modelGap(a) ?? 0)
    })
  }, [board.rows, selectedSport, sortMode, teamSearch])

  const selectedRow = rows.find((row) => row.game_id === selectedGameId) ?? rows[0] ?? null
  const topGap = rows.reduce<number | null>((largest, row) => {
    const gap = modelGap(row)
    if (gap === null || !Number.isFinite(gap) || gap <= 0) return largest
    return largest === null || gap > largest ? gap : largest
  }, null)
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
            <option value="cover">Best gap / odds</option>
            <option value="gap">Model gap</option>
            <option value="move">Price move</option>
          </select>
        </label>

        <div className="data-source">
          <span>Live feed</span>
          <strong>{liveLabel}</strong>
          <small>{refreshing ? 'Updating now' : `Auto-refreshes every 5 minutes`}</small>
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
            <span>Top gap</span>
            <strong>{formatSigned(topGap)}</strong>
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
                  {formatWeatherImpact(selectedRow) ? (
                    <>
                      <br />
                      {formatWeather(selectedRow)} / {formatWeatherImpact(selectedRow)}
                    </>
                  ) : null}
                </p>
                <div className="line-chart" aria-label="Opening to current line">
                  <span>Prev {formatCents(selectedRow.contract?.previous_price ?? selectedRow.market.opening_spread)}</span>
                  <strong>Last {formatCents(selectedRow.contract?.last_price ?? selectedRow.market.consensus_spread)}</strong>
                  <span>Move {formatNumber(selectedRow.metrics.line_move)}</span>
                </div>
              </div>
              <div className="detail-stack">
                <div>
                  <span>Odds</span>
                  <strong>{formatCents(coverOdds(selectedRow))}</strong>
                  <small>Current price for this line; move {formatSigned(selectedRow.metrics.line_move)}</small>
                </div>
                <div>
                  <span>Model gap</span>
                  <strong>{formatSigned(modelGap(selectedRow))}</strong>
                  <small>
                    {selectedRow.bluechip?.model_line ?? 'Model unavailable'} vs {selectedRow.bluechip?.market_line ?? consensusLabel(selectedRow)}
                  </small>
                </div>
                {formatWeatherImpact(selectedRow) ? (
                  <div>
                    <span>Weather adjustment</span>
                    <strong>{formatSigned(selectedRow.weather_impact?.total_adjustment ?? null)} pts</strong>
                    <small>{formatWeather(selectedRow)}</small>
                  </div>
                ) : null}
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

          <div className="breakdown-header" aria-hidden="true">
            <span>#</span>
            <span>Game</span>
            <span>Line</span>
            <span>Gap / confidence</span>
            <span>Odds</span>
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
                    <strong>
                      {row.away_team} vs {row.home_team}
                    </strong>
                    <small>
                      {row.sport} / {marketTypeLabel(row)} / {formatDate(row.commence_time)}
                    </small>
                  </span>
                  <span className="row-market">
                    <span className="mobile-label">Line</span>
                    <strong>{consensusLabel(row)}</strong>
                    <small>{row.bluechip?.model_line ? `Model ${row.bluechip.model_line}` : 'Model gap unavailable'}</small>
                  </span>
                  <span className="row-signals">
                    <span>
                      <b>Gap</b>
                      <strong>{formatSigned(modelGap(row))}</strong>
                    </span>
                    <span className={`confidence ${confidenceClass(row.metrics.confidence_score)}`}>
                      {confidenceLabel(row.metrics.confidence_score)}
                    </span>
                  </span>
                  <span className="row-odds">
                    <span className="mobile-label">Odds</span>
                    <strong>{formatCents(coverOdds(row))}</strong>
                    <small>Move {formatSigned(row.metrics.line_move)}</small>
                  </span>
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
