import { useEffect, useState, useSyncExternalStore } from 'react'
import { SENSORS, SENSOR_HINT, SENSOR_LABEL } from '../config'
import { capturesCsv, download, readingsCsv } from '../state/csv'
import * as db from '../state/db'
import { captures, lastBaseline, seriesFrom, type Series } from '../state/series'
import { store } from '../state/store'
import { Chart, type Win } from './Chart'
import { clock, mmss } from './format'
import { CaptureTable, CompareChart, SessionList } from './Tables'

const WINDOWS: [Win, string][] = [[60, '1 min'], [300, '5 min'], [900, '15 min'], [0, 'All']]
const CONN_LABEL = { disconnected: 'Disconnected', connecting: 'Connecting', connected: 'Connected' }
const STEPS: [string, string][] = [['warmup', 'Warming up'], ['baseline', 'Baseline'], ['ready', 'Ready'], ['capturing', 'Capturing']]
const CAPTURE_S = 5
const LUNG_ACTIVITIES = [
  ['breath', 'Breathing practice', '5 calm minutes'],
  ['move', 'Gentle movement', '20 minutes today'],
  ['air', 'Fresh-air pause', 'Step outside'],
  ['water', 'Hydration check', 'Drink some water'],
] as const
const FAMILY_MEMBERS = ['Ronaldo', 'Messi', 'Verstappen', 'Hamilton', 'Mohid'] as const
type FamilyMember = typeof FAMILY_MEMBERS[number]
const PULMO_TWIN = {
  status: 'Stable baseline',
  score: 82,
  consistency: '78%',
  recovery: '6h 40m',
  nextCheckIn: 'Tomorrow, 09:00',
  trend: [58, 62, 60, 68, 66, 74, 82],
}
const PULMO_HISTORY = [72, 76, 68, 81, 84, 79, 86, 88, 74, 69, 77, 83, 91, 87, 80, 82, 78, 85, 89, 92, 86, 81, 84, 90, 88, 93, 87, 90, 94, 92, 89]
const WEEK_SPRINTS = [
  { label: 'Current sprint', range: 'Oct 4 - Oct 10, 2026', days: [['oct-4', 'Sun 4', 81], ['oct-5', 'Mon 5', 84], ['oct-6', 'Tue 6', 79], ['oct-7', 'Wed 7', 86], ['oct-8', 'Thu 8', 88], ['oct-9', 'Fri 9', 74], ['oct-10', 'Sat 10', 69]] },
  { label: 'Past sprint', range: 'Sep 27 - Oct 3, 2026', days: [['sep-27', 'Sun 27', 78], ['sep-28', 'Mon 28', 82], ['sep-29', 'Tue 29', 80], ['sep-30', 'Wed 30', 85], ['oct-1', 'Thu 1', 72], ['oct-2', 'Fri 2', 76], ['oct-3', 'Sat 3', 68]] },
  { label: 'Past sprint', range: 'Sep 20 - Sep 26, 2026', days: [['sep-20', 'Sun 20', 83], ['sep-21', 'Mon 21', 87], ['sep-22', 'Tue 22', 81], ['sep-23', 'Wed 23', 89], ['sep-24', 'Thu 24', 86], ['sep-25', 'Fri 25', 91], ['sep-26', 'Sat 26', 84]] },
  { label: 'Past sprint', range: 'Sep 13 - Sep 19, 2026', days: [['sep-13', 'Sun 13', 74], ['sep-14', 'Mon 14', 79], ['sep-15', 'Tue 15', 77], ['sep-16', 'Wed 16', 82], ['sep-17', 'Thu 17', 88], ['sep-18', 'Fri 18', 80], ['sep-19', 'Sat 19', 85]] },
] as const
const FAMILY_SCORES: Record<FamilyMember, number[]> = {
  Ronaldo: [86, 91, 88, 94, 89, 82, 87],
  Messi: [78, 82, 80, 85, 88, 84, 81],
  Verstappen: [72, 76, 81, 79, 86, 91, 88],
  Hamilton: [84, 79, 87, 90, 92, 86, 89],
  Mohid: [80, 84, 82, 88, 91, 86, 90],
}
const FAMILY_PROFILES: Record<FamilyMember, {
  status: string
  score: number
  consistency: string
  recovery: string
  exposure: string
  confidence: string
  forecast: string
  insight: string
  trend: number[]
}> = {
  Ronaldo: { status: 'Strong baseline', score: 89, consistency: '86%', recovery: '7h 18m', exposure: 'Low', confidence: '91%', forecast: 'Maintaining your current rhythm should support a strong week ahead.', insight: 'Your most consistent days follow an early movement routine.', trend: [76, 80, 79, 85, 83, 88, 89] },
  Messi: { status: 'Steady baseline', score: 83, consistency: '78%', recovery: '6h 52m', exposure: 'Low', confidence: '87%', forecast: 'A little more consistency in recovery could lift your next seven-day score.', insight: 'Short breathing pauses are your most reliable positive signal.', trend: [72, 76, 75, 78, 80, 82, 83] },
  Verstappen: { status: 'Building baseline', score: 81, consistency: '74%', recovery: '6h 31m', exposure: 'Moderate', confidence: '84%', forecast: 'Reducing late-day exposure and protecting recovery time may improve stability.', insight: 'Your strongest readings follow lower-intensity recovery days.', trend: [68, 71, 76, 73, 79, 80, 81] },
  Hamilton: { status: 'Balanced baseline', score: 87, consistency: '82%', recovery: '7h 04m', exposure: 'Low', confidence: '89%', forecast: 'Your current pattern is trending steadily with room for small gains.', insight: 'Hydration and a regular wind-down are reinforcing your rhythm.', trend: [74, 78, 81, 80, 84, 85, 87] },
  Mohid: { status: 'Improving baseline', score: 86, consistency: '80%', recovery: '6h 48m', exposure: 'Low', confidence: '88%', forecast: 'Your recent consistency points toward a stronger and more stable week ahead.', insight: 'Your best pattern appears when movement and recovery stay balanced.', trend: [71, 75, 78, 80, 82, 84, 86] },
}
const DAY_TASKS = [
  ['Breathing practice', '5 calm minutes', 58],
  ['Gentle movement', '20 minutes of easy movement', 70],
  ['Fresh-air pause', 'Step outside for a few minutes', 65],
  ['Hydration check', 'Drink water through the day', 55],
  ['Posture reset', 'Two minutes with an open chest', 76],
  ['Screen pause', 'Rest your eyes and breathe slowly', 80],
  ['Sleep routine', 'Begin winding down on time', 72],
  ['Quiet recovery', 'Take one unhurried pause', 68],
  ['Body check-in', 'Notice how your breathing feels', 84],
  ['Daily reflection', 'Record one thing you noticed', 90],
] as const

function usePref<T>(key: string, init: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key)
      return s == null ? init : (JSON.parse(s) as T)
    } catch {
      return init
    }
  })
  const set = (x: T) => {
    setV(x)
    try { localStorage.setItem(key, JSON.stringify(x)) } catch { /* private mode */ }
  }
  return [v, set] as const
}

function useDark() {
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const f = (e: MediaQueryListEvent) => setDark(e.matches)
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [])
  return dark
}

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="10" />
      <path d="M7 12c3-3 6 3 9 0s6-3 9 0M7 17c3-3 6 3 9 0s6-3 9 0M7 22c3-3 6 3 9 0s6-3 9 0" />
    </svg>
  )
}

function Journey({ demo }: { demo: boolean }) {
  const { state, warmupLeft, warmupTotal } = store.device
  const idx = STEPS.findIndex(([k]) => k === state)
  const start = store.live.events.findLast((e) => e.kind === 'capture_start')?.t
  let msg = 'Waiting for the device to report its state.'
  let progress: number | null = null
  if (state === 'warmup') {
    msg = `The sensors are heating up. About ${mmss(warmupLeft)} to go.`
    if (warmupTotal) progress = 1 - warmupLeft / warmupTotal
  } else if (state === 'baseline') {
    msg = 'Measuring clean room air as the baseline. Keep breath away from the sensors for a moment.'
  } else if (state === 'ready') {
    msg = `Ready. Breathe gently toward the sensors, then press Start capture${demo ? '' : ' (or the button on the device)'} for a 5 second capture.`
  } else if (state === 'capturing') {
    msg = 'Capturing for 5 seconds. Keep breathing gently toward the sensors.'
    if (start) progress = Math.min(1, (Date.now() - start) / (CAPTURE_S * 1000))
  } else if (state) {
    msg = `Device state: ${state}`
  }
  return (
    <section className="card journey" aria-label="Device progress">
      <ol className="steps">
        {STEPS.map(([k, l], i) => (
          <li key={k} className={i === idx ? 'now' : idx > i ? 'done' : undefined}>
            <span className="num-dot">{i + 1}</span>{l}
          </li>
        ))}
      </ol>
      <div className="journey-msg">
        <p>{msg}</p>
        {(state === 'ready' || state === 'capturing') && (
          <button className="primary capture-btn" onClick={() => store.requestCapture()} disabled={state !== 'ready'}>
            {state === 'capturing' ? 'Capturing…' : 'Start capture'}
          </button>
        )}
      </div>
      {progress != null && (
        <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <i style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </section>
  )
}

function Onboarding() {
  const s = store
  if (s.conn === 'connecting')
    return (
      <div className="onboard">
        <div>
          <h3><span className="pulse" /> Looking for the device</h3>
          <p>Trying {s.url}. Make sure this laptop is on the PulmoSense WiFi network and the device is switched on.</p>
        </div>
      </div>
    )
  if (s.conn === 'connected')
    return (
      <div className="onboard">
        <div><h3><span className="pulse" /> Connected</h3><p>Waiting for the first reading.</p></div>
      </div>
    )
  return (
    <div className="onboard">
      <div>
        <h3>Let's get connected</h3>
        <p className="muted">Not connected. Join the PulmoSense WiFi network, then press Connect, or turn on demo mode.</p>
        <ol className="howto">
          <li><span><b>Switch on</b> the PulmoSense device.</span></li>
          <li><span><b>Join the WiFi</b> network called PulmoSense on this laptop (default password pulmosense1).</span></li>
          <li><span><b>Press Connect</b> at the top.</span></li>
        </ol>
        <div className="or"><span>no device handy?</span></div>
        <button className="primary" onClick={() => void s.setDemo(true)}>Try demo mode</button>
      </div>
    </div>
  )
}

function Pulmoverse({ onBack }: { onBack: () => void }) {
  const [member, setMember] = usePref<FamilyMember>('pulmoverse-family-member', 'Ronaldo')
  const [familyDone, setFamilyDone] = usePref<Record<FamilyMember, Record<string, boolean>>>('pulmoverse-family-activities', {} as Record<FamilyMember, Record<string, boolean>>)
  const [view, setView] = useState<'overview' | 'forecast'>('overview')
  const [selectedDate, setSelectedDate] = useState({ key: 'oct-8', label: 'October 8, 2026', score: 88 })
  const [dayFocus, setDayFocus] = useState(false)
  const done = familyDone[member] ?? {}
  const completed = LUNG_ACTIVITIES.filter(([id]) => done[id]).length
  const rhythm = completed >= 3 ? 'Strong rhythm' : completed > 0 ? 'Building rhythm' : 'Ready to begin'
  const forecast = completed >= 3 ? 'Your routine is supporting a steadier recovery pattern.' : 'Complete a few small actions to build a more useful personal trend.'
  const updateDone = (next: Record<string, boolean>) => setFamilyDone({ ...familyDone, [member]: next })
  const resetActivities = () => updateDone({})
  const dayScore = selectedDate.score
  const familyScores = FAMILY_SCORES[member]
  const profile = FAMILY_PROFILES[member]
  const trendPoints = profile.trend.map((value, index) => `${index * 70},${82 - (value - 60) * 1.15}`).join(' ')
  const dayCompleted = DAY_TASKS.filter(([, , minimum]) => dayScore >= minimum).length
  const formatDateLabel = (key: string) => {
    const [month, day] = key.split('-')
    return `${month === 'oct' ? 'October' : 'September'} ${day}, 2026`
  }

  return (
    <main className={`pulmoverse ${dayFocus ? 'day-focus' : ''}`} aria-label="Pulmoverse">
      <video className="pulmoverse-video" autoPlay muted loop playsInline>
        <source src="/309619_medium.mp4" type="video/mp4" />
      </video>
      <div className="pulmoverse-shade" />
      <div className="pulmoverse-topline">
        <button className="verse-back" onClick={onBack} aria-label="Back to PulmoSense">← Back to PulmoSense</button>
        <span className="verse-mark">PULMO<span>VERSE</span></span>
      </div>
      <nav className="family-switcher" aria-label="Family members">
        <span>Family health</span>
        {FAMILY_MEMBERS.map((name) => <button key={name} className={member === name ? 'selected' : ''} onClick={() => { setMember(name); setDayFocus(false); setSelectedDate({ key: 'current', label: 'Today', score: FAMILY_SCORES[name][4] }) }}>{name}</button>)}
      </nav>
      <section className="twin-card">
        <div className="twin-card-heading">
          <div>
            <p className="verse-panel-kicker">Personal health model</p>
            <h1>{member}'s digital lung twin</h1>
            <p className="twin-subtitle">A personal snapshot within your family health circle.</p>
          </div>
          <span className="model-status"><i />{profile.status}</span>
        </div>
        <nav className="twin-tabs" aria-label="Lung twin views">
          <button className={view === 'overview' ? 'selected' : ''} onClick={() => setView('overview')}>Overview</button>
          <button className={view === 'forecast' ? 'selected' : ''} onClick={() => setView('forecast')}>Forecast</button>
        </nav>
        <div className="twin-content">
          <div className="twin-orbit" aria-label={`${member}'s digital lung twin visualization`}><span /><i /><b>{member.slice(0, 2).toUpperCase()}</b></div>
          <div className="twin-summary">
            <p className="verse-panel-kicker">Current pattern</p>
            <h2>{view === 'overview' ? rhythm : `${member}'s positive direction`}</h2>
            <p>{view === 'overview' ? profile.insight : profile.forecast}</p>
            <small>Personal model confidence: {profile.confidence}. Not a medical diagnosis.</small>
          </div>
        </div>
        {view === 'forecast' && (
          <div className="trend-chart" aria-label="Seven day personal trend">
            <div className="trend-label"><span>7-day personal trend</span><b>+{profile.trend.at(-1)! - profile.trend[0]}%</b></div>
            <svg viewBox="0 0 420 90" preserveAspectRatio="none" role="img">
              <polyline points={trendPoints} className="trend-line" />
              <polygon points={`${trendPoints} 420,90 0,90`} className="trend-fill" />
            </svg>
            <div className="trend-days"><span>7 days ago</span><span>Today</span></div>
          </div>
        )}
        <div className="forecast-grid">
          <div><span>Twin score</span><b>{profile.score}/100</b><small>{profile.status}</small></div>
          <div><span>Routine consistency</span><b>{profile.consistency}</b><small>Last 7 days</small></div>
          <div><span>Recovery</span><b>{profile.recovery}</b><small>Typical nightly window</small></div>
        </div>
        <div className="model-signals">
          <div><span>Air exposure</span><b>{profile.exposure}</b></div>
          <div><span>Forecast confidence</span><b>{profile.confidence}</b></div>
          <div><span>Next check-in</span><b>{PULMO_TWIN.nextCheckIn}</b></div>
        </div>
      </section>
      <aside className="verse-dashboard">
        <section className="verse-panel tracker-panel">
          <div className="verse-panel-heading">
            <div>
              <p className="verse-panel-kicker">Today · {member}</p>
                <h2>Health rhythm</h2>
            </div>
              <div className="tracker-count"><strong>{completed}/{LUNG_ACTIVITIES.length}</strong><button onClick={resetActivities}>Reset</button></div>
          </div>
          <div className="verse-progress"><i style={{ width: `${completed / LUNG_ACTIVITIES.length * 100}%` }} /></div>
          <div className="activity-list">
            {LUNG_ACTIVITIES.map(([id, title, detail]) => (
              <label className={`activity ${done[id] ? 'complete' : ''}`} key={id}>
                <input type="checkbox" checked={!!done[id]} onChange={(e) => updateDone({ ...done, [id]: e.target.checked })} />
                <span className="activity-check" />
                <span><b>{title}</b><small>{detail}</small></span>
              </label>
            ))}
          </div>
        </section>
        <section className="verse-panel advice-panel">
          <p className="verse-panel-kicker">A gentle reminder</p>
          <p>Notice your breath without forcing it. Small, consistent pauses can make room for better awareness.</p>
        </section>
      </aside>
      <section className="verse-calendar">
        <div className="calendar-heading">
          <div>
            <p className="verse-panel-kicker">Daily history</p>
            <h2>{dayFocus ? selectedDate.label : 'Weekly sprints'}</h2>
          </div>
          <div className="calendar-selected"><b>{selectedDate.score}</b><span>daily score</span></div>
        </div>
        {!dayFocus ? (
          <>
            <div className="week-scroll" aria-label="Weekly health history">
              {WEEK_SPRINTS.map((week) => {
                return <section className="history-week" key={week.range}>
                  <div className="week-label"><span>{week.label}</span><small>{week.range}</small></div>
                  <div className="week-days">
                    {week.days.map(([key, label, baseScore], index) => {
                      const score = week.label === 'Current sprint' ? familyScores[index] : Math.max(60, Math.min(96, baseScore + familyScores[index] - 84))
                      return <button key={key} className={`calendar-day score-${score >= 88 ? 'high' : score >= 76 ? 'mid' : 'low'} ${key === selectedDate.key ? 'selected' : ''}`} onClick={() => { setSelectedDate({ key, label: formatDateLabel(key), score }); setDayFocus(true) }}><span>{label.slice(0, 3)}</span><b>{label.split(' ')[1]}</b><em>{score}</em></button>
                    })}
                  </div>
                </section>
              })}
            </div>
            <div className="calendar-legend"><span><i className="legend-low" /> Building</span><span><i className="legend-mid" /> Steady</span><span><i className="legend-high" /> Strong</span><span className="week-hint">Swipe for past sprints →</span></div>
          </>
        ) : (
          <div className="day-tasks">
            <div className="day-tasks-heading"><span>Personal tasks completed</span><button onClick={() => setDayFocus(false)}>Back to month</button></div>
            <div className="day-metrics">
              <div><span>Daily score</span><b>{dayScore}</b><small>{dayScore >= 88 ? 'Strong day' : dayScore >= 76 ? 'Steady day' : 'Building day'}</small></div>
              <div><span>Tasks complete</span><b>{dayCompleted}/10</b><small>{Math.round(dayCompleted / DAY_TASKS.length * 100)}% of your plan</small></div>
              <div><span>Personal rhythm</span><b>{dayScore >= 84 ? 'Balanced' : 'Developing'}</b><small>Based on your daily marks</small></div>
            </div>
            <div className="day-task-list">
              {DAY_TASKS.map(([title, detail, minimum], index) => {
                const checked = selectedDate.score >= minimum
                return <div className={`day-task ${checked ? 'checked' : ''}`} key={title}><span className="task-number">{String(index + 1).padStart(2, '0')}</span><span className="task-check">{checked ? '✓' : ''}</span><span className="task-copy"><b>{title}</b><small>{detail}</small></span><em>{checked ? 'Complete' : 'Open'}</em></div>
              })}
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

export function App() {
  useSyncExternalStore(store.subscribe, store.getVersion)
  const s = store
  const [win, setWin] = usePref<Win>('win', 300)
  const [autoY, setAutoY] = usePref('autoY', false)
  const [paused, setPaused] = useState(false)
  const [viewing, setViewing] = useState<{ meta: db.SessionMeta; series: Series } | null>(null)
  const [inPulmoverse, setInPulmoverse] = useState(false)
  const [toastGone, setToastGone] = useState(0)
  const dark = useDark()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement).closest('input, button, textarea, select, summary')) return
      e.preventDefault()
      setPaused((p) => !p)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setToastGone(s.toast.id), 3500)
    return () => clearTimeout(t)
  }, [s.toast.id])

  const open = async (m: db.SessionMeta) => {
    if (m.id === s.rec?.meta.id) await s.flush()
    const { readings, events } = await db.loadSession(m.id)
    setViewing({ meta: m, series: seriesFrom(m.start, readings, events) })
    scrollTo({ top: 0, behavior: 'smooth' })
  }

  const exportCsv = async (m: db.SessionMeta, what: 'readings' | 'captures') => {
    if (m.id === s.rec?.meta.id) await s.flush()
    const { readings, events } = await db.loadSession(m.id)
    const file = `pulmosense-${m.name.replace(/[^\w-]+/g, '_')}-${what}.csv`
    download(file, what === 'readings' ? readingsCsv(m, readings, events) : capturesCsv(m, events))
  }

  const remove = async (m: db.SessionMeta) => {
    if (!confirm(`Delete "${m.name}"? This cannot be undone.`)) return
    if (viewing?.meta.id === m.id) setViewing(null)
    await s.deleteSession(m.id)
  }

  const series = viewing?.series ?? s.live
  const caps = captures(series.events)
  const connected = s.conn !== 'disconnected'
  const live = s.conn === 'connected' && !s.stale
  const baseline = lastBaseline(s.live.events)
  const connClass = s.stale ? 'stale' : s.conn

  if (inPulmoverse) return <Pulmoverse onBack={() => setInPulmoverse(false)} />

  return (
    <>
      <header className="top">
        <div className="brand">
          <Logo />
          <div>
            <h1>PulmoSense</h1>
            <span className="muted small">breath sensor logger</span>
          </div>
        </div>
        <div className="connect">
          <button className="verse-link" onClick={() => setInPulmoverse(true)}>Dive into PULMOVERSE <span>↗</span></button>
          <span className={`pill conn ${connClass}`} role="status"><i />{s.stale ? 'No data for 3 s' : CONN_LABEL[s.conn]}</span>
          {!s.demo && (
            <label className="addr">
              <span className="sr-only">Device address</span>
              <input value={s.url} onChange={(e) => s.setUrl(e.target.value)} disabled={connected} spellCheck={false} />
            </label>
          )}
          <button className="primary" onClick={() => (connected ? s.disconnect() : s.connect())}>
            {connected ? 'Disconnect' : 'Connect'}
          </button>
          <label className="switch">
            <input type="checkbox" role="switch" checked={s.demo} onChange={(e) => void s.setDemo(e.target.checked)} />
            <span>Demo mode</span>
          </label>
          {s.demo && <span className="sim-tag">Simulated data</span>}
        </div>
      </header>

      {s.notice && <p className="notice" role="alert">{s.notice}</p>}

      {!viewing && connected && s.device.state && <Journey demo={s.demo} />}

      <main className="layout">
        <section className="card plot">
          <div className="toolbar">
            {viewing ? (
              <>
                <span className="viewing">
                  Viewing <strong>{viewing.meta.name}</strong>
                  {viewing.meta.source === 'simulated' && <span className="sim-tag">Simulated data</span>}
                  <span className="muted"> · read-only · drag to zoom, double-click to reset</span>
                </span>
                <button onClick={() => setViewing(null)}>Back to live</button>
              </>
            ) : (
              <>
                <span className="seg" role="group" aria-label="Chart window">
                  {WINDOWS.map(([w, l]) => (
                    <button key={w} aria-pressed={win === w} onClick={() => setWin(w)}>{l}</button>
                  ))}
                </span>
                <button onClick={() => setPaused(!paused)} aria-pressed={paused} aria-keyshortcuts="Space">
                  {paused ? 'Resume' : 'Pause'}
                </button>
                {paused && <span className="muted small">Paused. New readings are still kept.</span>}
              </>
            )}
            <label className="switch small-switch">
              <input type="checkbox" role="switch" checked={autoY} onChange={(e) => setAutoY(e.target.checked)} />
              <span>Auto-scale</span>
            </label>
          </div>
          <div className="plot-area">
            <Chart
              key={`${dark}-${viewing?.meta.id ?? 'live'}`}
              series={series}
              version={viewing ? 0 : s.version}
              win={win}
              autoY={autoY}
              paused={!viewing && paused}
              zoomable={!!viewing}
            />
          </div>
        </section>

        <aside className="side">
          <section className="card">
            <h2>Right now</h2>
            <div className="tiles">
              {SENSORS.map((k, i) => (
                <div key={k} className={`tile s${i + 1}`}>
                  <div className="tile-head">
                    <i className={`swatch s${i + 1}`} />
                    <b>{SENSOR_LABEL[k]}</b>
                    <span className="muted small">{SENSOR_HINT[k]}</span>
                  </div>
                  <div className="big">{live && s.last ? s.last[k].toFixed(3) : '-.---'}<small> V</small></div>
                  <div className="muted small mono">
                    {baseline
                      ? `baseline ${baseline.v[k].toFixed(3)} V${live && s.last ? ` · ×${(s.last[k] / baseline.v[k]).toFixed(2)}` : ''}`
                      : 'baseline not taken yet'}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="card rec">
            <h2>Recording</h2>
            {s.rec ? (
              <>
                <p className="rec-live"><span className="pulse" /> Recording <b className="mono">{mmss((Date.now() - s.rec.meta.start) / 1000)}</b> · {s.rec.count} readings</p>
                <button className="primary wide" onClick={() => void s.stopRecording()}>Stop recording</button>
              </>
            ) : (
              <>
                <p className="muted">{connected ? 'Save everything from now on as a session you can open and export later.' : 'Connect first, then record a session.'}</p>
                <button className="primary wide" onClick={() => void s.startRecording()} disabled={!connected}>
                  <span className="rec-dot" /> Start recording
                </button>
              </>
            )}
          </section>
        </aside>
      </main>

      <section className="card block">
        <h2>Captures{viewing && <span className="muted"> in {viewing.meta.name}</span>}</h2>
        <CaptureTable series={series} caps={caps} />
        <CompareChart caps={caps} />
      </section>

      <section className="card block">
        <h2>Sessions</h2>
        <SessionList
          sessions={s.sessions}
          activeId={s.rec?.meta.id ?? null}
          viewingId={viewing?.meta.id ?? null}
          onOpen={open}
          onRename={(m, name) => void s.renameSession(m, name)}
          onDelete={remove}
          onExport={exportCsv}
        />
      </section>

      <details className="card block log">
        <summary>Device log <span className="muted">({s.log.length})</span></summary>
        <ol>
          {s.log.toReversed().map((l, i) => (
            <li key={`${l.t}-${s.log.length - i}`}><time>{clock(l.t)}</time> {l.text}</li>
          ))}
        </ol>
      </details>

      {s.toast.id > toastGone && s.toast.text && (
        <div className="toast" role="status" key={s.toast.id}>{s.toast.text}</div>
      )}

      <footer>Prototype. Not a medical device. Values are sensor voltages, not a diagnosis.</footer>
    </>
  )
}
