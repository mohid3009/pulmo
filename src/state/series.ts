import { GAP_MS, SENSORS, type Sensor } from '../config'
import type { Volts } from '../parse/parse'

/** t is the browser clock on arrival (epoch ms). Device uptime is not wall-clock time. */
export type Reading = { t: number; state: string } & Volts
export type Event =
  | { t: number; kind: 'baseline'; v: Volts }
  | { t: number; kind: 'capture_start' }
  | { t: number; kind: 'capture'; n: number; v: Volts; ratio: Volts }
export type Capture = Extract<Event, { kind: 'capture' }>

/** Chart-ready columns. x is seconds since t0; a null row breaks the line across a dropout. */
export type Series = { t0: number; x: number[]; y: Record<Sensor, (number | null)[]>; events: Event[] }

export const emptySeries = (t0 = 0): Series => ({ t0, x: [], y: { mq3: [], mq135: [], mq7: [] }, events: [] })

export const toX = (s: Series, t: number) => (t - s.t0) / 1000

export function pushReading(s: Series, r: Reading) {
  if (!s.t0) s.t0 = r.t
  const x = toX(s, r.t)
  const last = s.x[s.x.length - 1]
  if (last !== undefined) {
    if (x <= last) return // browser clock stepped back; uPlot needs sorted x
    if (x - last > GAP_MS / 1000) {
      s.x.push(last + 0.001)
      for (const k of SENSORS) s.y[k].push(null)
    }
  }
  s.x.push(x)
  for (const k of SENSORS) s.y[k].push(r[k])
}

export function pushEvent(s: Series, e: Event) {
  if (!s.t0) s.t0 = e.t
  s.events.push(e)
}

export function seriesFrom(t0: number, readings: Reading[], events: Event[]): Series {
  const s = emptySeries(t0)
  for (const r of readings) pushReading(s, r)
  for (const e of events) pushEvent(s, e)
  return s
}

export const lastBaseline = (events: Event[]) =>
  events.findLast((e): e is Extract<Event, { kind: 'baseline' }> => e.kind === 'baseline')

export const captures = (events: Event[]) => events.filter((e): e is Capture => e.kind === 'capture')

/** Shaded capture windows in x units. end null = still capturing. */
export function captureSpans(s: Series) {
  const out: { start: number; end: number | null; n: number | null }[] = []
  let open: (typeof out)[number] | null = null
  for (const e of s.events) {
    const x = toX(s, e.t)
    if (e.kind === 'capture_start') {
      if (open) out.push({ ...open, end: x })
      open = { start: x, end: null, n: null }
    } else if (e.kind === 'capture') {
      // No start seen (joined mid-capture): shade the 5 s the device averaged over.
      out.push(open ? { ...open, end: x, n: e.n } : { start: x - 5, end: x, n: e.n })
      open = null
    }
  }
  if (open) out.push(open)
  return out
}

/** Each baseline holds until the next one (a device restart takes a new baseline). */
export function baselineSegs(s: Series) {
  const bs = s.events.filter((e): e is Extract<Event, { kind: 'baseline' }> => e.kind === 'baseline')
  return bs.map((b, i) => ({ start: toX(s, b.t), end: bs[i + 1] ? toX(s, bs[i + 1].t) : null, v: b.v }))
}
