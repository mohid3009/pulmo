import { SENSORS } from '../config'
import type { Volts } from '../parse/parse'
import type { ConnStatus, DataSource } from './source'

const WARMUP_S = 20
const BASELINE_S = 5
const CAPTURE_S = 5
const REST: Volts = { mq3: 0.82, mq135: 1.02, mq7: 0.66 }
const BREATH: Volts = { mq3: 0.28, mq135: 0.45, mq7: 0.07 }

const r3 = (v: number) => Math.round(v * 1000) / 1000
const noise = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.012
const avg = (xs: Volts[]): Volts => {
  const o = { mq3: 0, mq135: 0, mq7: 0 }
  for (const k of SENSORS) o[k] = r3(xs.reduce((a, x) => a + x[k], 0) / xs.length)
  return o
}

/** Emits the same JSON frames as the firmware, at 2 Hz. Shortened warm-up. */
export class SimSource implements DataSource {
  readonly kind = 'simulated' as const
  onMessage = (_text: string) => {}
  onStatus = (_s: ConnStatus, _note?: string) => {}

  private timer?: ReturnType<typeof setInterval>
  private t0 = 0
  private n = 0
  private baseline: Volts | null = null
  private baseSamples: Volts[] = []
  private capture: { start: number; gain: number; samples: Volts[] } | null = null

  connect() {
    clearInterval(this.timer)
    this.t0 = performance.now()
    this.n = 0
    this.baseline = null
    this.baseSamples = []
    this.capture = null
    this.onStatus('connected', 'Demo mode started')
    this.send({ type: 'hello', state: 'warmup', hasBaseline: false })
    this.timer = setInterval(() => this.tick(), 500)
  }

  disconnect() {
    clearInterval(this.timer)
    this.onStatus('disconnected', 'Demo mode stopped')
  }

  /** Same as pressing the device button: only acts when ready. */
  requestCapture() {
    if (this.baseline && !this.capture) this.capture = { start: this.elapsed(), gain: 0.6 + Math.random() * 0.8, samples: [] }
  }

  private elapsed = () => (performance.now() - this.t0) / 1000
  private send = (o: object) => this.onMessage(JSON.stringify(o))

  private tick() {
    const s = this.elapsed()
    const state = s < WARMUP_S ? 'warmup' : !this.baseline ? 'baseline' : this.capture ? 'capturing' : 'ready'
    const cold = Math.exp(-s / 6) // MQ heaters read high when cold and settle as they warm
    const p = this.capture ? (s - this.capture.start) / CAPTURE_S : 1
    const breath = p < 1 ? Math.sin(Math.PI * p) ** 0.7 * this.capture!.gain : 0

    const v = { mq3: 0, mq135: 0, mq7: 0 }
    for (const k of SENSORS) v[k] = r3(REST[k] * (1 + 0.9 * cold) + BREATH[k] * breath + noise())
    this.send({ type: 'live', ms: Math.round(s * 1000), ...v, state, warmupLeft: state === 'warmup' ? Math.ceil(WARMUP_S - s) : 0 })

    if (state === 'baseline') {
      this.baseSamples.push(v)
      if (s >= WARMUP_S + BASELINE_S) {
        this.baseline = avg(this.baseSamples)
        this.send({ type: 'baseline', ...this.baseline })
      }
    }
    if (this.capture && this.baseline) {
      this.capture.samples.push(v)
      if (p >= 1) {
        const a = avg(this.capture.samples)
        const b = this.baseline
        this.send({
          type: 'capture', n: ++this.n, ...a,
          ratioMq3: r3(a.mq3 / b.mq3), ratioMq135: r3(a.mq135 / b.mq135), ratioMq7: r3(a.mq7 / b.mq7),
        })
        this.capture = null
      }
    }
  }
}
