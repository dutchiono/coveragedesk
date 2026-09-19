import { useEffect, useMemo, useState } from 'react'

type SportLabel = 'NFL' | 'NCAAF'
type Page = 'board' | 'detail' | 'performance'

type RatingRow = {
  sport: string
  team: string
  power_rating: number
  injury_adj: number
  form_adj: number
}

type HistoryRow = {
  model_market_edge: number
  market_novig: number
  cover_result: number
  model_probability: number
}

type ApiOutcome = {
  name: string
  price?: number
  point?: number
}

type ApiMarket = {
  key: string
  outcomes: ApiOutcome[]
}

type ApiBookmaker = {
  title: string
  markets: ApiMarket[]
}

type ApiEvent = {
  id: string
  commence_time: string
  home_team: string
  away_team: string
  bookmakers: ApiBookmaker[]
}

type FlatLine = {
  sport: SportLabel
  event_id: string
  commence_time: string
  home_team: string
  away_team: string
  book: string
  home_spread: number
  home_price: number
  home_novig: number
  away_spread: number
  away_price: number
  away_novig: number
}

type BoardRow = {
  event_id: string
  sport: SportLabel
  commence_time: string
  away_team: string
  home_team: string
  books: string[]
  book_count: number
  market_spread_home: number
  market_price_home: number
  market_novig_home: number
  model_margin_home: number | null
  model_spread_home: number | null
  model_edge: number
  home_cover_probability: number
  away_cover_probability: number
  recommended_side: string
  coverage_probability: number
  confidence_score: number
  confidence_label: string
}

const sports: Record<SportLabel, string> = {
  NFL: 'americanfootball_nfl',
  NCAAF: 'americanfootball_ncaaf',
}

const ratingTemplate = `sport,team,power_rating,injury_adj,form_adj
NFL,Demo Team A,88,0,0
NFL,Demo Team B,82,0,0
NFL,Demo Team C,84,0,0.5
NFL,Demo Team D,79,-0.5,0
NCAAF,Demo State,91,0,0.5
NCAAF,Demo University,78,0,0
NCAAF,Demo Tech,85,0.5,0
NCAAF,Demo College,81,0,-0.5`

const historyTemplate = `model_market_edge,line_move,injury_edge,form_edge,rest_edge,home_field,market_novig,cover_result,model_probability
2.4,0.5,0,0,0,1.7,0.524,1,0.59
-1.2,-0.5,0.5,0,0,3.0,0.476,0,0.46`

const demoHistory = `model_market_edge,line_move,injury_edge,form_edge,rest_edge,home_field,market_novig,cover_result,model_probability
2.4,0.5,0,0,0,1.7,0.524,1,0.59
-1.2,-0.5,0.5,0,0,3.0,0.476,0,0.46
3.1,1.0,0,0.5,0,1.7,0.531,1,0.61
-2.8,-1.5,0,0,0,3.0,0.488,0,0.43
1.6,0,0,0,0,1.7,0.514,1,0.56
-0.8,0.5,0,0,0,3.0,0.501,1,0.49
2.1,0,0,0,0,1.7,0.522,0,0.57
4.0,1.5,0,0.5,0,3.0,0.545,1,0.64
-3.5,-1.0,0,0,0,1.7,0.482,0,0.40
1.1,0,0,0,0,3.0,0.506,1,0.54`

function americanToProbability(odds: number) {
  if (!Number.isFinite(odds)) return Number.NaN
  return odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100)
}

function noVigTwoWay(a: number, b: number) {
  const pa = americanToProbability(a)
  const pb = americanToProbability(b)
  const total = pa + pb
  if (!Number.isFinite(total) || total <= 0) return [Number.NaN, Number.NaN]
  return [pa / total, pb / total]
}

function erf(x: number) {
  const sign = x < 0 ? -1 : 1
  const abs = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * abs)
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-abs * abs))
  return sign * y
}

function normalCdf(value: number) {
  return 0.5 * (1 + erf(value / Math.sqrt(2)))
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b)
  if (!sorted.length) return Number.NaN
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function average(values: number[]) {
  const usable = values.filter(Number.isFinite)
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : Number.NaN
}

function baselineCoverProbability(modelMarginHome: number, marketSpreadHome: number, sport: SportLabel) {
  const edge = modelMarginHome + marketSpreadHome
  const sd = sport === 'NFL' ? 15.5 : 17
  return { homeCover: normalCdf(edge / sd), edge }
}

function confidenceLabel(score: number) {
  if (score >= 84) return 'Strong'
  if (score >= 72) return 'Good'
  if (score >= 62) return 'Moderate'
  return 'Thin'
}

function parseCsv(text: string) {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]
    if (char === '"' && quoted && next === '"') {
      field += '"'
      i += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (char === ',' && !quoted) {
      row.push(field.trim())
      field = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1
      row.push(field.trim())
      if (row.some(Boolean)) rows.push(row)
      field = ''
      row = []
    } else {
      field += char
    }
  }

  row.push(field.trim())
  if (row.some(Boolean)) rows.push(row)

  const [header, ...body] = rows
  if (!header) return []
  return body.map((cells) =>
    Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ''])),
  ) as Record<string, string>[]
}

function toNumber(value: string, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function buildRatingRows(text: string) {
  return parseCsv(text).map((row) => ({
    sport: row.sport,
    team: row.team,
    power_rating: toNumber(row.power_rating),
    injury_adj: toNumber(row.injury_adj),
    form_adj: toNumber(row.form_adj),
  }))
}

function buildHistoryRows(text: string) {
  return parseCsv(text).map((row) => ({
    model_market_edge: toNumber(row.model_market_edge),
    market_novig: toNumber(row.market_novig, 0.5),
    cover_result: toNumber(row.cover_result),
    model_probability: toNumber(row.model_probability, toNumber(row.market_novig, 0.5)),
  }))
}

function flattenOdds(events: ApiEvent[], sport: SportLabel) {
  const rows: FlatLine[] = []
  for (const event of events) {
    for (const book of event.bookmakers ?? []) {
      const spreadMarket = book.markets?.find((market) => market.key === 'spreads')
      if (!spreadMarket || spreadMarket.outcomes.length !== 2) continue
      const home = spreadMarket.outcomes.find((outcome) => outcome.name === event.home_team)
      const away = spreadMarket.outcomes.find((outcome) => outcome.name === event.away_team)
      if (
        !home ||
        !away ||
        home.price === undefined ||
        away.price === undefined ||
        home.point === undefined ||
        away.point === undefined
      ) {
        continue
      }
      const [homeNoVig, awayNoVig] = noVigTwoWay(home.price, away.price)
      rows.push({
        sport,
        event_id: event.id,
        commence_time: event.commence_time,
        home_team: event.home_team,
        away_team: event.away_team,
        book: book.title,
        home_spread: home.point,
        home_price: home.price,
        home_novig: homeNoVig,
        away_spread: away.point,
        away_price: away.price,
        away_novig: awayNoVig,
      })
    }
  }
  return rows
}

function makeRatingMap(ratings: RatingRow[]) {
  return new Map(
    ratings.map((rating) => [
      `${rating.sport.toUpperCase()}::${rating.team.toLowerCase()}`,
      rating.power_rating + rating.injury_adj + rating.form_adj,
    ]),
  )
}

function calibrationBias(history: HistoryRow[]) {
  const usable = history.filter((row) => row.cover_result === 0 || row.cover_result === 1)
  if (usable.length < 8) return 0
  const error =
    usable.reduce((sum, row) => sum + (row.cover_result - row.model_probability), 0) / usable.length
  return clamp(error * 0.35, -0.06, 0.06)
}

function buildBoard(lines: FlatLine[], ratings: RatingRow[], history: HistoryRow[], homeField: Record<SportLabel, number>) {
  const ratingMap = makeRatingMap(ratings)
  const bias = calibrationBias(history)
  const groups = new Map<string, FlatLine[]>()

  for (const line of lines) {
    const key = `${line.sport}::${line.event_id}`
    groups.set(key, [...(groups.get(key) ?? []), line])
  }

  return [...groups.values()]
    .map((group) => {
      const sample = group[0]
      const awayRating = ratingMap.get(`${sample.sport}::${sample.away_team.toLowerCase()}`)
      const homeRating = ratingMap.get(`${sample.sport}::${sample.home_team.toLowerCase()}`)
      const marketSpreadHome = median(group.map((line) => line.home_spread))
      const marketPriceHome = Math.round(median(group.map((line) => line.home_price)))
      const marketNoVigHome = average(group.map((line) => line.home_novig))
      const margin =
        awayRating === undefined || homeRating === undefined
          ? null
          : homeRating - awayRating + homeField[sample.sport]
      const baseline =
        margin === null
          ? { homeCover: marketNoVigHome, edge: 0 }
          : baselineCoverProbability(margin, marketSpreadHome, sample.sport)
      const homeCover = clamp(baseline.homeCover + bias, 0.01, 0.99)
      const awayCover = 1 - homeCover
      const coverage = Math.max(homeCover, awayCover)
      const dataScore =
        56 +
        Math.min(group.length, 8) * 4 +
        (margin === null ? 0 : 14) +
        (history.length >= 8 ? 8 : 0) +
        Math.min(Math.abs(baseline.edge), 4) * 1.5
      const confidence = Math.round(clamp(dataScore, 48, 96))

      return {
        event_id: sample.event_id,
        sport: sample.sport,
        commence_time: sample.commence_time,
        away_team: sample.away_team,
        home_team: sample.home_team,
        books: group.map((line) => line.book),
        book_count: group.length,
        market_spread_home: marketSpreadHome,
        market_price_home: marketPriceHome,
        market_novig_home: marketNoVigHome,
        model_margin_home: margin,
        model_spread_home: margin === null ? null : -margin,
        model_edge: baseline.edge,
        home_cover_probability: homeCover,
        away_cover_probability: awayCover,
        recommended_side: homeCover >= 0.5 ? sample.home_team : sample.away_team,
        coverage_probability: coverage,
        confidence_score: confidence,
        confidence_label: confidenceLabel(confidence),
      }
    })
    .sort((a, b) => b.coverage_probability - a.coverage_probability || Math.abs(b.model_edge) - Math.abs(a.model_edge))
}

function makeDemoLines() {
  const demoEvents: ApiEvent[] = [
    {
      id: 'demo-nfl-1',
      commence_time: new Date(Date.now() + 1000 * 60 * 60 * 8).toISOString(),
      home_team: 'Demo Team A',
      away_team: 'Demo Team B',
      bookmakers: [
        {
          title: 'DraftKings',
          markets: [{ key: 'spreads', outcomes: [{ name: 'Demo Team A', point: -4.5, price: -110 }, { name: 'Demo Team B', point: 4.5, price: -110 }] }],
        },
        {
          title: 'FanDuel',
          markets: [{ key: 'spreads', outcomes: [{ name: 'Demo Team A', point: -5, price: -105 }, { name: 'Demo Team B', point: 5, price: -115 }] }],
        },
        {
          title: 'BetMGM',
          markets: [{ key: 'spreads', outcomes: [{ name: 'Demo Team A', point: -4.5, price: -112 }, { name: 'Demo Team B', point: 4.5, price: -108 }] }],
        },
      ],
    },
    {
      id: 'demo-nfl-2',
      commence_time: new Date(Date.now() + 1000 * 60 * 60 * 30).toISOString(),
      home_team: 'Demo Team C',
      away_team: 'Demo Team D',
      bookmakers: [
        {
          title: 'Caesars',
          markets: [{ key: 'spreads', outcomes: [{ name: 'Demo Team C', point: -3.5, price: -108 }, { name: 'Demo Team D', point: 3.5, price: -112 }] }],
        },
        {
          title: 'ESPN BET',
          markets: [{ key: 'spreads', outcomes: [{ name: 'Demo Team C', point: -3, price: -115 }, { name: 'Demo Team D', point: 3, price: -105 }] }],
        },
      ],
    },
    {
      id: 'demo-ncaaf-1',
      commence_time: new Date(Date.now() + 1000 * 60 * 60 * 52).toISOString(),
      home_team: 'Demo State',
      away_team: 'Demo University',
      bookmakers: [
        {
          title: 'DraftKings',
          markets: [{ key: 'spreads', outcomes: [{ name: 'Demo State', point: -11.5, price: -110 }, { name: 'Demo University', point: 11.5, price: -110 }] }],
        },
        {
          title: 'FanDuel',
          markets: [{ key: 'spreads', outcomes: [{ name: 'Demo State', point: -12, price: -108 }, { name: 'Demo University', point: 12, price: -112 }] }],
        },
      ],
    },
    {
      id: 'demo-ncaaf-2',
      commence_time: new Date(Date.now() + 1000 * 60 * 60 * 80).toISOString(),
      home_team: 'Demo Tech',
      away_team: 'Demo College',
      bookmakers: [
        {
          title: 'BetMGM',
          markets: [{ key: 'spreads', outcomes: [{ name: 'Demo Tech', point: -6.5, price: -105 }, { name: 'Demo College', point: 6.5, price: -115 }] }],
        },
        {
          title: 'Caesars',
          markets: [{ key: 'spreads', outcomes: [{ name: 'Demo Tech', point: -7, price: -110 }, { name: 'Demo College', point: 7, price: -110 }] }],
        },
      ],
    },
  ]

  return [
    ...flattenOdds(demoEvents.slice(0, 2), 'NFL'),
    ...flattenOdds(demoEvents.slice(2), 'NCAAF'),
  ]
}

function performance(history: HistoryRow[]) {
  const usable = history.filter((row) => row.cover_result === 0 || row.cover_result === 1)
  if (!usable.length) return null
  const brier =
    usable.reduce((sum, row) => sum + (row.model_probability - row.cover_result) ** 2, 0) /
    usable.length
  const logLoss =
    usable.reduce((sum, row) => {
      const p = clamp(row.model_probability, 0.001, 0.999)
      return sum - (row.cover_result * Math.log(p) + (1 - row.cover_result) * Math.log(1 - p))
    }, 0) / usable.length
  const hitRate = usable.reduce((sum, row) => sum + row.cover_result, 0) / usable.length
  return { sample: usable.length, brier, logLoss, hitRate }
}

function calibrationBands(history: HistoryRow[]) {
  const bands = [
    [0.5, 0.52],
    [0.52, 0.54],
    [0.54, 0.56],
    [0.56, 0.58],
    [0.58, 0.6],
    [0.6, 0.62],
    [0.62, 1],
  ]
  return bands.map(([min, max]) => {
    const rows = history.filter((row) => row.model_probability >= min && row.model_probability < max)
    const actual = rows.length
      ? rows.reduce((sum, row) => sum + row.cover_result, 0) / rows.length
      : null
    return { label: `${(min * 100).toFixed(0)}-${max === 1 ? '100' : (max * 100).toFixed(0)}%`, rows, actual }
  })
}

function formatDate(value: string) {
  if (!value) return 'TBD'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function formatNumber(value: number | null, digits = 1) {
  return value === null || !Number.isFinite(value) ? '-' : value.toFixed(digits)
}

function toCsv(rows: BoardRow[]) {
  const header = [
    'sport',
    'commence_time',
    'away_team',
    'home_team',
    'book_count',
    'market_spread_home',
    'market_price_home',
    'model_spread_home',
    'model_edge',
    'recommended_side',
    'coverage_probability',
    'confidence_score',
  ]
  const lines = rows.map((row) =>
    header
      .map((key) => {
        const value = row[key as keyof BoardRow]
        return `"${String(value ?? '').replaceAll('"', '""')}"`
      })
      .join(','),
  )
  return [header.join(','), ...lines].join('\n')
}

function App() {
  const [apiKey, setApiKey] = useState('')
  const [region, setRegion] = useState('us')
  const [selectedSports, setSelectedSports] = useState<SportLabel[]>(['NFL', 'NCAAF'])
  const [ratings, setRatings] = useState<RatingRow[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [lines, setLines] = useState<FlatLine[]>([])
  const [status, setStatus] = useState('Ready')
  const [error, setError] = useState('')
  const [dataStatus, setDataStatus] = useState('Loading managed CSV data...')
  const [loading, setLoading] = useState(false)
  const [activePage, setActivePage] = useState<Page>('board')
  const [selectedEventId, setSelectedEventId] = useState('')
  const [minEdge, setMinEdge] = useState(1.5)
  const [minProbability, setMinProbability] = useState(0.54)
  const [homeField, setHomeField] = useState<Record<SportLabel, number>>({ NFL: 1.7, NCAAF: 3 })

  const board = useMemo(() => buildBoard(lines, ratings, history, homeField), [lines, ratings, history, homeField])
  const filteredBoard = board.filter(
    (row) =>
      selectedSports.includes(row.sport) &&
      Math.abs(row.model_edge) >= minEdge &&
      row.coverage_probability >= minProbability,
  )
  const selectedRow =
    board.find((row) => row.event_id === selectedEventId) ?? filteredBoard[0] ?? board[0] ?? null
  const stats = performance(history)
  const strongest = filteredBoard[0] ?? board[0]
  const modelLines = board.filter((row) => row.model_margin_home !== null).length

  useEffect(() => {
    async function loadManagedData() {
      try {
        const [ratingsResponse, historyResponse] = await Promise.all([
          fetch('/data/ratings.csv'),
          fetch('/data/historical_training.csv'),
        ])
        if (!ratingsResponse.ok) throw new Error('ratings.csv could not be loaded')
        if (!historyResponse.ok) throw new Error('historical_training.csv could not be loaded')
        setRatings(buildRatingRows(await ratingsResponse.text()))
        setHistory(buildHistoryRows(await historyResponse.text()))
        setDataStatus('Managed ratings and history loaded')
      } catch (managedDataError) {
        setDataStatus(
          managedDataError instanceof Error ? managedDataError.message : 'Managed CSV data failed to load',
        )
      }
    }

    void loadManagedData()
  }, [])

  function toggleSport(sport: SportLabel) {
    setSelectedSports((current) =>
      current.includes(sport) ? current.filter((item) => item !== sport) : [...current, sport],
    )
  }

  function loadDemo() {
    setRatings(buildRatingRows(ratingTemplate))
    setHistory(buildHistoryRows(demoHistory))
    setLines(makeDemoLines())
    setStatus('Demo board loaded')
    setError('')
  }

  async function fetchOdds() {
    if (!apiKey.trim()) {
      setError('Enter an Odds API key first, or use demo mode.')
      return
    }
    if (selectedSports.length === 0) {
      setError('Select at least one sport.')
      return
    }

    setLoading(true)
    setError('')
    setStatus('Loading live spreads...')

    try {
      const fetched = await Promise.all(
        selectedSports.map(async (sport) => {
          const params = new URLSearchParams({
            apiKey: apiKey.trim(),
            regions: region,
            markets: 'spreads',
            oddsFormat: 'american',
          })
          const response = await fetch(
            `https://api.the-odds-api.com/v4/sports/${sports[sport]}/odds?${params.toString()}`,
          )
          if (!response.ok) throw new Error(`${sport}: ${response.status} ${response.statusText}`)
          return flattenOdds((await response.json()) as ApiEvent[], sport)
        }),
      )
      const nextLines = fetched.flat()
      setLines(nextLines)
      setStatus(`Loaded ${nextLines.length.toLocaleString()} book lines.`)
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Could not load odds. If the browser blocks the request, deploy a small API proxy.',
      )
      setStatus('Live request failed')
    } finally {
      setLoading(false)
    }
  }

  function downloadBoard() {
    const blob = new Blob([toCsv(filteredBoard.length ? filteredBoard : board)], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'markbets-coverage-board.csv'
    anchor.click()
    URL.revokeObjectURL(url)
  }

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
          {(['board', 'detail', 'performance'] as Page[]).map((page) => (
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

        <label className="field">
          <span>Odds API key</span>
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Paste key for this session"
            type="password"
          />
        </label>

        <label className="field">
          <span>Book region</span>
          <select value={region} onChange={(event) => setRegion(event.target.value)}>
            <option value="us">US</option>
            <option value="us2">US2</option>
          </select>
        </label>

        <div className="field">
          <span>Sports</span>
          <div className="segmented">
            {(['NFL', 'NCAAF'] as SportLabel[]).map((sport) => (
              <button
                className={selectedSports.includes(sport) ? 'selected' : ''}
                key={sport}
                onClick={() => toggleSport(sport)}
                type="button"
              >
                {sport}
              </button>
            ))}
          </div>
        </div>

        <label className="range-field">
          <span>Minimum edge: {minEdge.toFixed(1)}</span>
          <input
            max="5"
            min="0"
            onChange={(event) => setMinEdge(Number(event.target.value))}
            step="0.5"
            type="range"
            value={minEdge}
          />
        </label>

        <label className="range-field">
          <span>Minimum probability: {formatPct(minProbability)}</span>
          <input
            max="0.65"
            min="0.5"
            onChange={(event) => setMinProbability(Number(event.target.value))}
            step="0.01"
            type="range"
            value={minProbability}
          />
        </label>

        <div className="home-field">
          {(['NFL', 'NCAAF'] as SportLabel[]).map((sport) => (
            <label className="field compact" key={sport}>
              <span>{sport} home field</span>
              <input
                onChange={(event) =>
                  setHomeField((current) => ({ ...current, [sport]: Number(event.target.value) }))
                }
                step="0.1"
                type="number"
                value={homeField[sport]}
              />
            </label>
          ))}
        </div>

        <div className="data-source">
          <span>Managed model data</span>
          <strong>{ratings.length} teams</strong>
          <small>{history.length} history rows</small>
          <em>{dataStatus}</em>
        </div>

        <button className="primary" disabled={loading} onClick={fetchOdds} type="button">
          {loading ? 'Loading...' : 'Refresh odds'}
        </button>
        <button className="secondary" onClick={loadDemo} type="button">
          Load demo
        </button>
        <button className="secondary" disabled={!board.length} onClick={downloadBoard} type="button">
          Download board
        </button>
      </aside>

      <section className="content">
        <div className="topbar">
          <div>
            <p className="eyebrow">Market to model to validation</p>
            <h2>NFL and NCAA coverage probabilities</h2>
          </div>
          <div className="status">{status}</div>
        </div>

        {error ? <div className="notice">{error}</div> : null}

        <section className="metrics" aria-label="Summary">
          <div>
            <span>Games shown</span>
            <strong>{filteredBoard.length.toLocaleString()}</strong>
          </div>
          <div>
            <span>Rated games</span>
            <strong>{modelLines.toLocaleString()}</strong>
          </div>
          <div>
            <span>Top estimate</span>
            <strong>{strongest ? formatPct(strongest.coverage_probability) : '-'}</strong>
          </div>
          <div>
            <span>History sample</span>
            <strong>{stats ? stats.sample.toLocaleString() : '0'}</strong>
          </div>
        </section>

        {activePage === 'board' ? (
          <section className="board-panel">
            <div className="panel-heading">
              <div>
                <h3>Coverage board</h3>
                <p>Consensus spread rows ranked by model edge and calibrated coverage estimate.</p>
              </div>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Kickoff</th>
                    <th>Game</th>
                    <th>Books</th>
                    <th>Market</th>
                    <th>Model</th>
                    <th>Edge</th>
                    <th>Side</th>
                    <th>Cover</th>
                    <th>Conf.</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBoard.length ? (
                    filteredBoard.slice(0, 200).map((row) => (
                      <tr
                        className="selectable"
                        key={row.event_id}
                        onClick={() => {
                          setSelectedEventId(row.event_id)
                          setActivePage('detail')
                        }}
                      >
                        <td>{formatDate(row.commence_time)}</td>
                        <td>
                          <span className="game">{row.away_team}</span>
                          <span className="muted">at {row.home_team}</span>
                        </td>
                        <td>{row.book_count}</td>
                        <td>{formatNumber(row.market_spread_home)}</td>
                        <td>{formatNumber(row.model_spread_home)}</td>
                        <td>{formatNumber(row.model_edge)}</td>
                        <td>{row.recommended_side}</td>
                        <td>
                          <span className="probability">
                            <span style={{ width: `${row.coverage_probability * 100}%` }} />
                          </span>
                          {formatPct(row.coverage_probability)}
                        </td>
                        <td>
                          <span className={`badge ${row.confidence_label.toLowerCase()}`}>
                            {row.confidence_score}
                          </span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="empty" colSpan={9}>
                        Load demo data or refresh live odds, then adjust the filters.
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
                  <div className="line-chart" aria-label="Opening to current line placeholder">
                    <span>Opening pending</span>
                    <strong>Current {formatNumber(selectedRow.market_spread_home)}</strong>
                    <span>Closing after result</span>
                  </div>
                </div>
                <div className="detail-stack">
                  <div>
                    <span>Market consensus</span>
                    <strong>{formatNumber(selectedRow.market_spread_home)}</strong>
                    <small>{selectedRow.book_count} books, home price {selectedRow.market_price_home}</small>
                  </div>
                  <div>
                    <span>Model fair spread</span>
                    <strong>{formatNumber(selectedRow.model_spread_home)}</strong>
                    <small>Home field {homeField[selectedRow.sport].toFixed(1)} included</small>
                  </div>
                  <div>
                    <span>Probability</span>
                    <strong>{formatPct(selectedRow.coverage_probability)}</strong>
                    <small>
                      Home {formatPct(selectedRow.home_cover_probability)} / Away{' '}
                      {formatPct(selectedRow.away_cover_probability)}
                    </small>
                  </div>
                  <div>
                    <span>Reliability</span>
                    <strong>{selectedRow.confidence_score}</strong>
                    <small>{selectedRow.confidence_label}</small>
                  </div>
                </div>
                <div className="book-list">
                  <h3>Sportsbooks</h3>
                  <p>{selectedRow.books.join(', ')}</p>
                </div>
              </>
            ) : (
              <div className="empty-panel">No game selected yet.</div>
            )}
          </section>
        ) : null}

        {activePage === 'performance' ? (
          <section className="performance-grid">
            <div className="performance-card">
              <h3>Historical performance</h3>
              {stats ? (
                <dl>
                  <div>
                    <dt>Sample</dt>
                    <dd>{stats.sample}</dd>
                  </div>
                  <div>
                    <dt>Cover rate</dt>
                    <dd>{formatPct(stats.hitRate)}</dd>
                  </div>
                  <div>
                    <dt>Brier score</dt>
                    <dd>{stats.brier.toFixed(3)}</dd>
                  </div>
                  <div>
                    <dt>Log loss</dt>
                    <dd>{stats.logLoss.toFixed(3)}</dd>
                  </div>
                </dl>
              ) : (
                <p>Upload historical rows or load demo data to calculate performance.</p>
              )}
            </div>
            <div className="performance-card">
              <h3>Probability bands</h3>
              <div className="bands">
                {calibrationBands(history).map((band) => (
                  <div key={band.label}>
                    <span>{band.label}</span>
                    <strong>{band.rows.length ? formatPct(band.actual ?? 0) : '-'}</strong>
                    <small>{band.rows.length} games</small>
                  </div>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        <section className="templates" aria-label="CSV templates">
          <details>
            <summary>Managed ratings CSV format</summary>
            <pre>{ratingTemplate}</pre>
          </details>
          <details>
            <summary>Managed historical CSV format</summary>
            <pre>{historyTemplate}</pre>
          </details>
        </section>
      </section>
    </main>
  )
}

export default App
