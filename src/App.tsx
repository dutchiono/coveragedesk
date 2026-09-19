import { useEffect, useMemo, useState } from 'react'

type SportLabel = 'ALL' | 'NFL' | 'NCAAF'
type Page = 'board' | 'detail' | 'status'

type BoardRow = {
  game_id: string
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
  metrics: {
    model_market_gap: number | null
    line_move: number | null
    confidence_score: number
  }
  updated_at: string
}

type BoardResponse = {
  generated_at: string
  source: 'live' | 'preview'
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

function confidenceLabel(score: number) {
  if (score >= 84) return 'Strong'
  if (score >= 72) return 'Good'
  if (score >= 62) return 'Moderate'
  return 'Thin'
}

function consensusLabel(row: BoardRow) {
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
  const [sortMode, setSortMode] = useState('gap')
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
      if (sortMode === 'books') return b.market.book_count - a.market.book_count
      return Math.abs(b.metrics.model_market_gap ?? 0) - Math.abs(a.metrics.model_market_gap ?? 0)
    })
  }, [board.rows, selectedSport, sortMode])

  const selectedRow = rows.find((row) => row.game_id === selectedGameId) ?? rows[0] ?? null
  const topGap = rows.find((row) => row.metrics.model_market_gap !== null)?.metrics.model_market_gap ?? null
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
            <option value="move">Line move</option>
            <option value="books">Book count</option>
          </select>
        </label>

        <div className="data-source">
          <span>Odds backend</span>
          <strong>{board.source === 'live' ? 'Live odds' : 'Preview'}</strong>
          <small>{rows.length} games</small>
          <em>{board.status}</em>
        </div>

        <button className="primary" disabled={loading} onClick={refreshBoard} type="button">
          {loading ? 'Refreshing...' : 'Refresh odds'}
        </button>
      </aside>

      <section className="content">
        <div className="topbar">
          <div>
            <p className="eyebrow">Backend-ranked sportsbook markets</p>
            <h2>Consensus lines, movement, and model gaps</h2>
          </div>
          <div className="status">{board.source === 'live' ? 'API connected' : 'Preview mode'}</div>
        </div>

        <section className="metrics" aria-label="Summary">
          <div>
            <span>Games</span>
            <strong>{rows.length.toLocaleString()}</strong>
          </div>
          <div>
            <span>Largest gap</span>
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
                <p>The backend pulls odds, stores line snapshots, and sends this precomputed board.</p>
              </div>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Kickoff</th>
                    <th>Game</th>
                    <th>Consensus</th>
                    <th>Fair spread</th>
                    <th>Gap</th>
                    <th>Move</th>
                    <th>Books</th>
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
                          <span className="game">{row.away_team}</span>
                          <span className="muted">at {row.home_team}</span>
                        </td>
                        <td>{consensusLabel(row)}</td>
                        <td>{formatNumber(row.model.fair_spread)}</td>
                        <td>{formatNumber(row.metrics.model_market_gap)}</td>
                        <td>{formatNumber(row.metrics.line_move)}</td>
                        <td>{row.market.book_count}</td>
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
                        No odds are available yet. Set `ODDS_API_KEY` on the backend and refresh.
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
                  <h3>
                    {selectedRow.away_team} at {selectedRow.home_team}
                  </h3>
                  <div className="line-chart" aria-label="Opening to current line">
                    <span>Open {formatNumber(selectedRow.market.opening_spread)}</span>
                    <strong>Consensus {formatNumber(selectedRow.market.consensus_spread)}</strong>
                    <span>Move {formatNumber(selectedRow.metrics.line_move)}</span>
                  </div>
                </div>
                <div className="detail-stack">
                  <div>
                    <span>Specific-book timestamp</span>
                    <strong>{selectedRow.market.latest_book ?? '-'}</strong>
                    <small>{formatDate(selectedRow.market.latest_timestamp)}</small>
                  </div>
                  <div>
                    <span>Best available</span>
                    <strong>
                      {formatNumber(selectedRow.market.best_favorite_line)} /{' '}
                      {formatNumber(selectedRow.market.best_underdog_line)}
                    </strong>
                    <small>Favorite / underdog line</small>
                  </div>
                  <div>
                    <span>Model source</span>
                    <strong>{selectedRow.model.source ?? 'none'}</strong>
                    <small>{formatDate(selectedRow.model.updated_at)}</small>
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
                `/api/board` returns sportsbook consensus, best available lines, line movement,
                and optional model-vs-market gaps. The browser does not calculate odds.
              </p>
            </div>
          </section>
        ) : null}
      </section>
    </main>
  )
}

export default App
