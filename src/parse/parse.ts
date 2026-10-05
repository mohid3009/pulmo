import { MAX_VOLTS, SENSORS } from '../config'

export type Volts = { mq3: number; mq135: number; mq7: number }

export type Msg =
  | { type: 'hello'; state: string; hasBaseline: boolean }
  | ({ type: 'live'; ms: number; state: string; warmupLeft: number } & Volts)
  | ({ type: 'baseline' } & Volts)
  | ({ type: 'capture'; n: number; ratio: Volts } & Volts)

/** null = ignored (unknown type). Never throws. */
export type ParseResult = { msg: Msg } | { error: string } | null

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function readVolts(o: Record<string, unknown>): Volts | string {
  for (const k of SENSORS) {
    const v = o[k]
    if (!isNum(v)) return `${k} is not a number`
    if (v < 0 || v > MAX_VOLTS) return `${k}=${v} V is outside 0 to ${MAX_VOLTS} V`
  }
  return { mq3: o.mq3 as number, mq135: o.mq135 as number, mq7: o.mq7 as number }
}

export function parseFrame(text: string): ParseResult {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return { error: `Malformed frame: ${text.slice(0, 80)}` }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: `Not a JSON object: ${text.slice(0, 80)}` }
  const m = o as Record<string, unknown>

  switch (m.type) {
    case 'hello':
      return { msg: { type: 'hello', state: String(m.state ?? ''), hasBaseline: m.hasBaseline === true } }

    case 'live': {
      if (!isNum(m.ms)) return { error: 'Dropped live frame: ms is not a number' }
      const v = readVolts(m)
      if (typeof v === 'string') return { error: `Dropped live frame: ${v}` }
      const warmupLeft = isNum(m.warmupLeft) ? m.warmupLeft : 0
      return { msg: { type: 'live', ms: m.ms, state: String(m.state ?? ''), warmupLeft, ...v } }
    }

    case 'baseline': {
      const v = readVolts(m)
      if (typeof v === 'string') return { error: `Dropped baseline frame: ${v}` }
      return { msg: { type: 'baseline', ...v } }
    }

    case 'capture': {
      const v = readVolts(m)
      if (typeof v === 'string') return { error: `Dropped capture frame: ${v}` }
      const r = [m.ratioMq3, m.ratioMq135, m.ratioMq7]
      if (!isNum(m.n) || !r.every(isNum)) return { error: 'Dropped capture frame: n or ratio is not a number' }
      const [mq3, mq135, mq7] = r as number[]
      return { msg: { type: 'capture', n: m.n, ...v, ratio: { mq3, mq135, mq7 } } }
    }

    default:
      return null
  }
}

/** Device `ms` is uptime; going backwards means the device restarted. */
export const isReboot = (prevMs: number | null, ms: number) => prevMs !== null && ms < prevMs
