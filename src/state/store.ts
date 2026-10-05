import { DEFAULT_URL, FLUSH_MS, SENSORS, STALE_MS } from '../config'
import { isReboot, parseFrame, type Volts } from '../parse/parse'
import { SimSource } from '../sources/sim'
import type { ConnStatus, DataSource } from '../sources/source'
import { WsSource } from '../sources/ws'
import * as db from './db'
import { emptySeries, lastBaseline, pushEvent, pushReading, type Event, type Reading } from './series'

export const HTTPS_BLOCKED =
  'This page was opened over https, and browsers block ws:// connections from https pages. ' +
  'Run the app from http://localhost (npm run dev) to reach the device.'

const pref = (k: string) => {
  try { return localStorage.getItem(k) } catch { return null }
}
const savePref = (k: string, v: string) => {
  try { localStorage.setItem(k, v) } catch { /* private mode */ }
}
const pick = (m: Volts): Volts => ({ mq3: m.mq3, mq135: m.mq135, mq7: m.mq7 })

type Recording = { meta: db.SessionMeta; readings: Reading[]; events: Event[]; count: number }

/** All live state. React reads it via useSyncExternalStore(subscribe, getVersion). */
class Store {
  version = 0
  url = pref('url') ?? DEFAULT_URL
  demo = false
  conn: ConnStatus = 'disconnected'
  stale = false
  notice = ''
  device = { state: '', warmupLeft: 0, warmupTotal: 0 }
  toast = { id: 0, text: '' }
  last: Reading | null = null
  live = emptySeries()
  log: { t: number; text: string }[] = []
  rec: Recording | null = null
  sessions: db.SessionMeta[] = []

  private listeners = new Set<() => void>()
  private src: DataSource | null = null
  private prevMs: number | null = null
  private lastMsgAt = 0

  constructor() {
    setInterval(() => {
      const stale = this.conn === 'connected' && Date.now() - this.lastMsgAt > STALE_MS
      if (stale !== this.stale || this.rec) {
        this.stale = stale
        this.bump()
      }
    }, 500)
    setInterval(() => void this.flush(), FLUSH_MS)
    document.addEventListener('visibilitychange', () => document.hidden && void this.flush())
    void this.refreshSessions()
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  getVersion = () => this.version
  private bump() {
    this.version++
    this.listeners.forEach((f) => f())
  }

  addLog(text: string) {
    this.log.push({ t: Date.now(), text })
    if (this.log.length > 500) this.log.shift()
  }

  /** Short friendly notice for the UI; App hides it after a few seconds. */
  notify(text: string) {
    this.toast = { id: this.toast.id + 1, text }
  }

  setUrl(url: string) {
    this.url = url
    savePref('url', url)
    this.bump()
  }

  connect() {
    this.notice = ''
    let src: DataSource
    if (this.demo) {
      src = new SimSource()
    } else {
      const url = this.url.trim()
      if (!/^wss?:\/\//i.test(url)) {
        this.notice = 'The address must start with ws://, for example ws://192.168.4.1:81.'
        return this.bump()
      }
      if (location.protocol === 'https:' && /^ws:/i.test(url)) {
        this.notice = HTTPS_BLOCKED
        this.addLog('Blocked: ws:// address from an https page')
        return this.bump()
      }
      src = new WsSource(url)
    }
    src.onMessage = (t) => this.onText(t)
    src.onStatus = (status, note) => {
      this.conn = status
      if (status === 'connected') {
        this.lastMsgAt = Date.now()
        this.notify(this.demo ? 'Demo mode is running' : 'Connected to the device')
      }
      if (note) this.addLog(note)
      this.bump()
    }
    this.src = src
    src.connect()
  }

  disconnect() {
    this.src?.disconnect()
    this.src = null
  }

  async setDemo(on: boolean) {
    if (on === this.demo) return
    await this.stopRecording() // a session never mixes device and simulated data
    this.disconnect()
    this.demo = on
    this.notice = ''
    this.live = emptySeries()
    this.last = null
    this.device = { state: '', warmupLeft: 0, warmupTotal: 0 }
    this.prevMs = null
    this.addLog(on ? 'Switched to demo mode (simulated data)' : 'Switched to device')
    if (on) this.connect()
    this.bump()
  }

  /** Same as pressing the device button. Older firmware ignores the command, so say so if nothing happens. */
  requestCapture() {
    if (!this.src || this.device.state !== 'ready') return
    const asked = Date.now()
    this.src.requestCapture()
    this.addLog('Asked the device to start a capture')
    setTimeout(() => {
      if (this.live.events.some((e) => e.kind === 'capture_start' && e.t >= asked)) return
      const msg = 'The device did not start a capture. Flash the firmware in firmware/pulmosense, which accepts the Start capture command.'
      this.addLog(msg)
      this.notify(msg)
      this.bump()
    }, 2500)
  }

  private addEvent(e: Event) {
    pushEvent(this.live, e)
    this.rec?.events.push(e)
  }

  private onText(text: string) {
    const r = parseFrame(text)
    if (!r) return
    if ('error' in r) {
      this.addLog(r.error)
      return this.bump()
    }
    const m = r.msg
    const now = Date.now()
    this.lastMsgAt = now
    this.stale = false

    if (m.type === 'hello') {
      this.addLog(`Device hello: state ${m.state || 'unknown'}, ${m.hasBaseline ? 'baseline stored' : 'no baseline yet'}`)
    } else if (m.type === 'live') {
      if (isReboot(this.prevMs, m.ms)) {
        this.addLog('Device uptime went backwards: device restarted. Earlier data kept.')
        this.notify('The device restarted. Earlier data is kept.')
      }
      this.prevMs = m.ms
      if (m.state === 'capturing' && this.device.state !== 'capturing') this.addEvent({ t: now, kind: 'capture_start' })
      // The device only sends seconds left, so the longest countdown seen stands in for the total.
      const warming = m.state === 'warmup'
      const warmupTotal = warming && this.device.state === 'warmup' ? Math.max(this.device.warmupTotal, m.warmupLeft) : warming ? m.warmupLeft : 0
      this.device = { state: m.state, warmupLeft: m.warmupLeft, warmupTotal }
      const rd: Reading = { t: now, ...pick(m), state: m.state }
      this.last = rd
      pushReading(this.live, rd)
      if (this.rec) {
        this.rec.readings.push(rd)
        this.rec.count++
      }
    } else if (m.type === 'baseline') {
      const b = lastBaseline(this.live.events)
      // The device re-sends its baseline on every connect; only a changed one is a new event.
      if (!b || SENSORS.some((k) => b.v[k] !== m[k])) {
        this.addEvent({ t: now, kind: 'baseline', v: pick(m) })
        this.addLog(`Baseline: ${SENSORS.map((k) => m[k].toFixed(3)).join(' / ')} V`)
        this.notify('Baseline taken')
      }
    } else {
      this.addEvent({ t: now, kind: 'capture', n: m.n, v: pick(m), ratio: m.ratio })
      this.addLog(`Capture ${m.n} received`)
      this.notify(`Capture ${m.n} done. Results are in the table below.`)
    }
    this.bump()
  }

  async startRecording() {
    if (this.rec) return
    const start = Date.now()
    const draft = { name: `Session ${new Date(start).toLocaleString()}`, start, end: start, source: this.src?.kind ?? 'device' }
    const rec: Recording = { meta: { ...draft, id: 0 }, readings: [], events: [], count: 0 }
    const b = lastBaseline(this.live.events)
    if (b) rec.events.push({ ...b, t: start }) // so the session carries its baseline
    if (this.device.state === 'capturing') rec.events.push({ t: start, kind: 'capture_start' })
    this.rec = rec
    this.addLog('Recording started')
    this.notify('Recording started')
    rec.meta.id = await db.createSession(draft)
    await this.refreshSessions()
  }

  async flush() {
    const r = this.rec
    if (!r || !r.meta.id || (!r.readings.length && !r.events.length)) return
    const { readings, events } = r
    r.readings = []
    r.events = []
    r.meta.end = Date.now()
    try {
      await db.saveChunk(r.meta, readings, events)
    } catch (e) {
      r.readings = readings.concat(r.readings) // keep it for the next flush
      r.events = events.concat(r.events)
      this.addLog(`Could not save to browser storage: ${(e as Error).message}`)
    }
  }

  async stopRecording() {
    const r = this.rec
    if (!r) return
    await this.flush()
    this.rec = null
    r.meta.end = Date.now()
    if (r.meta.id) await db.putSession(r.meta)
    this.addLog(`Recording stopped (${r.count} readings)`)
    this.notify(`Saved ${r.count} readings to Sessions`)
    await this.refreshSessions()
  }

  async renameSession(m: db.SessionMeta, name: string) {
    if (this.rec?.meta.id === m.id) this.rec.meta.name = name // else the next flush would overwrite it
    await db.putSession({ ...m, name })
    await this.refreshSessions()
  }

  async deleteSession(id: number) {
    await db.deleteSession(id)
    await this.refreshSessions()
  }

  async refreshSessions() {
    this.sessions = (await db.listSessions()).reverse()
    this.bump()
  }
}

export const store = new Store()
