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

export function App() {
  useSyncExternalStore(store.subscribe, store.getVersion)
  const s = store
  const [win, setWin] = usePref<Win>('win', 300)
  const [autoY, setAutoY] = usePref('autoY', false)
  const [paused, setPaused] = useState(false)
  const [viewing, setViewing] = useState<{ meta: db.SessionMeta; series: Series } | null>(null)
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
            {!viewing && !s.live.x.length && <Onboarding />}
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
