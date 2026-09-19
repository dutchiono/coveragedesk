import { useEffect, useMemo, useState } from 'react'

type SportLabel = 'ALL' | 'NFL' | 'NCAAF'
type Page = 'board' | 'detail' | 'status'

type BoardRow = {
  game_id: string
  data_source?: 'sportsbook' | 'kalshi'
  sport: 'NFL' | 'NCAAF'
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

function confidenceLabel(score: number) {
  if (score >= 84) return 'Strong'
  if (score >= 72) return 'Good'
  if (score >= 62) return 'Moderate'
  return 'Thin'
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
  const [activePage, setActivePage] = useState<Page>('board')
  const [selectedSport, setSelectedSport] = useState<SportLabel>('ALL')
  const [sortMode, setSortMode] = useState('volume')
  const [selectedGameId, setSelectedGameId] = useState('')
  const [loading, setLoading] = useState(false)

  async function refreshBoard() {
    setLoading(true)
    setBoard(await fetchBoard())
    setLoading(false)
  }

  useEffect(() => {
    void refreshBoard()
  }, [])

  const rows = useMemo(() => {
    const sportRows =
      selectedSport === 'ALL' ? board.rows : board.rows.filter((row) => row.sport === selectedSport)
    return [...sportRows].sort((a, b) => {
      if (sortMode === 'move') {
        return Math.abs(b.metrics.line_move ?? 0) - Math.abs(a.metrics.line_move ?? 0)
      }
      if (sortMode === 'volume') return (b.contract?.volume_24h ?? 0) - (a.contract?.volume_24h ?? 0)
      if (sortMode === 'interest') return (b.contract?.open_interest ?? 0) - (a.contract?.open_interest ?? 0)
      if (sortMode === 'books') return b.market.book_count - a.market.book_count
      return Math.abs(b.metrics.model_market_gap ?? 0) - Math.abs(a.metrics.model_market_gap ?? 0)
    })
  }, [board.rows, selectedSport, sortMode])

  const selectedRow = rows.find((row) => row.game_id === selectedGameId) ?? rows[0] ?? null
  const topGap =
    rows.find((row) => row.metrics.model_market_gap !== null)?.metrics.model_market_gap ??
    rows.find((row) => row.contract?.price_move !== null)?.contract?.price_move ??
    null
  const latestUpdate = rows.reduce<string | null>((latest, row) => {
    if (!latest) return row.updated_at
    return new Date(row.updated_at) > new Date(latest) ? row.updated_at : latest
  }, null)

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

        <div className="nav-tabs" role="tablist">
          {(['board', 'detail', 'status'] as Page[]).map((page) => (
            <button
              className={activePage === page ? 'selected' : ''}
              key={page}
              onClick={() => setActivePage(page)}
              type="button"
            >
              {page}
            </button>
          ))}
        </div>

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
            <option value="gap">Model gap</option>
            <option value="move">Price move</option>
            <option value="volume">24h volume</option>
            <option value="interest">Open interest</option>
            <option value="books">Book count</option>
          </select>
        </label>

        <div className="data-source">
          <span>Odds backend</span>
          <strong>{board.source === 'kalshi' ? 'Kalshi live' : board.source === 'preview' ? 'Preview' : 'Live odds'}</strong>
          <small>{rows.length} markets</small>
          <em>{board.status}</em>
        </div>

        <button className="primary" disabled={loading} onClick={refreshBoard} type="button">
          {loading ? 'Refreshing...' : 'Refresh odds'}
        </button>
      </aside>

      <section className="content">
        <div className="topbar">
          <div>
            <p className="eyebrow">Backend-ranked live markets</p>
            <h2>Football lines, contract prices, and market movement</h2>
          </div>
          <div className="status">{board.source === 'preview' ? 'Preview mode' : 'API connected'}</div>
        </div>

        <section className="metrics" aria-label="Summary">
          <div>
            <span>Markets</span>
            <strong>{rows.length.toLocaleString()}</strong>
          </div>
          <div>
            <span>Largest move</span>
            <strong>{formatNumber(topGap)}</strong>
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

        {activePage === 'board' ? (
          <section className="board-panel">
            <div className="panel-heading">
              <div>
                <h3>Odds board</h3>
                <p>The backend pulls live markets and sends this precomputed board.</p>
              </div>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Kickoff</th>
                    <th>Market</th>
                    <th>Contract</th>
                    <th>Yes bid</th>
                    <th>Yes ask</th>
                    <th>Move</th>
                    <th>24h vol.</th>
                    <th>Open int.</th>
                    <th>Timestamp</th>
                    <th>Conf.</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length ? (
                    rows.slice(0, 200).map((row) => (
                      <tr
                        className="selectable"
                        key={row.game_id}
                        onClick={() => {
                          setSelectedGameId(row.game_id)
                          setActivePage('detail')
                        }}
                      >
                        <td>{formatDate(row.commence_time)}</td>
                        <td>
                          <span className="game">
                            {row.away_team} vs {row.home_team}
                          </span>
                          <span className="muted">{row.sport}</span>
                        </td>
                        <td>{consensusLabel(row)}</td>
                        <td>{formatCents(row.contract?.yes_bid ?? null)}</td>
                        <td>{formatCents(row.contract?.yes_ask ?? null)}</td>
                        <td>{formatNumber(row.metrics.line_move)}</td>
                        <td>{formatVolume(row.contract?.volume_24h)}</td>
                        <td>{formatVolume(row.contract?.open_interest)}</td>
                        <td>{formatDate(row.market.latest_timestamp)}</td>
                        <td>
                          <span className={`badge ${confidenceLabel(row.metrics.confidence_score).toLowerCase()}`}>
                            {row.metrics.confidence_score}
                          </span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="empty" colSpan={9}>
                        No live markets are available yet. Refresh in a minute.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {activePage === 'detail' ? (
          <section className="detail-grid">
            {selectedRow ? (
              <>
                <div className="detail-main">
                  <p className="eyebrow">{selectedRow.sport}</p>
                  <h3>{selectedRow.contract?.title ?? `${selectedRow.away_team} at ${selectedRow.home_team}`}</h3>
                  <div className="line-chart" aria-label="Opening to current line">
                    <span>Prev {formatCents(selectedRow.contract?.previous_price ?? selectedRow.market.opening_spread)}</span>
                    <strong>Last {formatCents(selectedRow.contract?.last_price ?? selectedRow.market.consensus_spread)}</strong>
                    <span>Move {formatNumber(selectedRow.metrics.line_move)}</span>
                  </div>
                </div>
                <div className="detail-stack">
                  <div>
                    <span>Market source</span>
                    <strong>{selectedRow.market.latest_book ?? '-'}</strong>
                    <small>{formatDate(selectedRow.market.latest_timestamp)}</small>
                  </div>
                  <div>
                    <span>Bid / ask</span>
                    <strong>
                      {formatCents(selectedRow.contract?.yes_bid ?? null)} / {formatCents(selectedRow.contract?.yes_ask ?? null)}
                    </strong>
                    <small>YES side</small>
                  </div>
                  <div>
                    <span>Activity</span>
                    <strong>{formatVolume(selectedRow.contract?.volume_24h)}</strong>
                    <small>24h volume, {formatVolume(selectedRow.contract?.open_interest)} open interest</small>
                  </div>
                  <div>
                    <span>Reliability</span>
                    <strong>{selectedRow.metrics.confidence_score}</strong>
                    <small>{confidenceLabel(selectedRow.metrics.confidence_score)}</small>
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-panel">No game selected yet.</div>
            )}
          </section>
        ) : null}

        {activePage === 'status' ? (
          <section className="performance-grid">
            <div className="performance-card">
              <h3>Backend status</h3>
              <p>{board.status}</p>
            </div>
            <div className="performance-card">
              <h3>Data contract</h3>
              <p>
                `/api/board` returns backend-ranked rows from sportsbook snapshots when configured,
                otherwise live read-only Kalshi football spread markets. The browser does not calculate odds.
              </p>
            </div>
          </section>
        ) : null}
      </section>
    </main>
  )
}

export default App
