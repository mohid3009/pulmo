import { describeRatio, SENSORS, SENSOR_LABEL } from '../config'
import type { SessionMeta } from '../state/db'
import type { Capture, Series } from '../state/series'
import { clock, mmss } from './format'

const GLYPH: Record<string, string> = { 'Below baseline': '↓', 'Near baseline': '≈', 'Above baseline': '↑' }
const Descriptor = ({ r }: { r: number }) => {
  const d = describeRatio(r)
  return <span className="desc"><span aria-hidden="true">{GLYPH[d] ?? '–'}</span> {d}</span>
}

export function CaptureTable({ series, caps }: { series: Series; caps: Capture[] }) {
  if (!caps.length) return <p className="empty">No captures yet. Once the device says Ready, breathe toward the sensors and press Start capture (or the button on the device).</p>
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Capture</th><th>Time</th><th>Sensor</th><th className="num">Volts (5 s avg)</th><th className="num">Ratio vs baseline</th><th>Descriptor</th>
        </tr>
      </thead>
      <tbody>
        {caps.map((c) =>
          SENSORS.map((k, i) => (
            <tr key={`${c.t}-${k}`} className={i === 0 ? 'group' : undefined}>
              <td className="num">{i === 0 ? c.n : ''}</td>
              <td className="num">{i === 0 ? `${mmss((c.t - series.t0) / 1000)} (${clock(c.t)})` : ''}</td>
              <td>{SENSOR_LABEL[k]}</td>
              <td className="num">{c.v[k].toFixed(3)}</td>
              <td className="num">{c.ratio[k].toFixed(3)}</td>
              <td><Descriptor r={c.ratio[k]} /></td>
            </tr>
          )),
        )}
      </tbody>
    </table>
  )
}

/** Grouped bars: ratio vs baseline per sensor, one group per capture. */
export function CompareChart({ caps }: { caps: Capture[] }) {
  if (caps.length < 2) return null
  const W = 720
  const H = 180
  const L = 40
  const B = 22
  const top = Math.max(1.5, ...caps.flatMap((c) => SENSORS.map((k) => c.ratio[k]))) * 1.08
  const y = (r: number) => H - B - (r / top) * (H - B - 6)
  const gw = (W - L) / caps.length
  const bw = Math.min(16, (gw - 8) / 3)
  const ticks = [0, 0.5, 1, 1.5, 2, 3, 4, 5].filter((t) => t <= top)
  return (
    <figure className="compare">
      <figcaption>
        Ratio vs baseline by capture.{' '}
        {SENSORS.map((k, i) => (
          <span key={k} className="key"><i style={{ background: `var(--s${i + 1})`, opacity: 1 - i * 0.25 }} />{SENSOR_LABEL[k]}</span>
        ))}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Ratio vs baseline per sensor for each capture">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W} y1={y(t)} y2={y(t)} className={t === 1 ? 'ref' : 'grid'} />
            <text x={L - 6} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">{t.toFixed(1)}</text>
          </g>
        ))}
        {caps.map((c, g) => {
          const x0 = L + g * gw + (gw - 3 * bw) / 2
          return (
            <g key={c.t}>
              {SENSORS.map((k, i) => (
                <rect key={k} x={x0 + i * bw} y={y(c.ratio[k])} width={bw - 2} height={H - B - y(c.ratio[k])}
                  fill={`var(--s${i + 1})`} fillOpacity={1 - i * 0.25}>
                  <title>{`Capture ${c.n}, ${SENSOR_LABEL[k]}: ${c.ratio[k].toFixed(3)}`}</title>
                </rect>
              ))}
              <text x={x0 + 1.5 * bw} y={H - 6} className="tick" textAnchor="middle">{c.n}</text>
            </g>
          )
        })}
      </svg>
    </figure>
  )
}

const dur = (ms: number) => mmss(ms / 1000)

type SessionsProps = {
  sessions: SessionMeta[]
  activeId: number | null
  viewingId: number | null
  onOpen: (m: SessionMeta) => void
  onRename: (m: SessionMeta, name: string) => void
  onDelete: (m: SessionMeta) => void
  onExport: (m: SessionMeta, what: 'readings' | 'captures') => void
}

export function SessionList({ sessions, activeId, viewingId, onOpen, onRename, onDelete, onExport }: SessionsProps) {
  if (!sessions.length) return <p className="empty">No saved sessions yet. Press Start recording while connected and they will show up here.</p>
  return (
    <table className="data sessions">
      <thead>
        <tr><th>Name</th><th>Start</th><th className="num">Duration</th><th>Source</th><th /></tr>
      </thead>
      <tbody>
        {sessions.map((m) => (
          <tr key={m.id} className={m.id === viewingId ? 'current' : undefined}>
            <td>
              <input className="name" defaultValue={m.name} aria-label="Session name"
                onBlur={(e) => e.target.value.trim() && e.target.value !== m.name && onRename(m, e.target.value.trim())}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
            </td>
            <td className="num">{new Date(m.start).toLocaleString()}</td>
            <td className="num">{m.id === activeId ? 'recording' : dur(m.end - m.start)}</td>
            <td>{m.source === 'simulated' ? <span className="sim-tag">Simulated data</span> : <span className="tag">device</span>}</td>
            <td className="actions">
              <button onClick={() => onOpen(m)}>Open</button>
              <button onClick={() => onExport(m, 'readings')}>Export CSV</button>
              <button onClick={() => onExport(m, 'captures')}>Captures CSV</button>
              <button onClick={() => onDelete(m)} disabled={m.id === activeId}>Delete</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
