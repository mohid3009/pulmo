import { DEAD_MS, RETRY_MS } from '../config'
import type { ConnStatus, DataSource } from './source'

/** Read-only WebSocket client with backoff retry until disconnect() is called. */
export class WsSource implements DataSource {
  readonly kind = 'device' as const
  onMessage = (_text: string) => {}
  onStatus = (_s: ConnStatus, _note?: string) => {}

  private ws: WebSocket | null = null
  private wanted = false
  private attempt = 0
  private lastSeen = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private watchdog?: ReturnType<typeof setInterval>

  constructor(private url: string) {}

  connect() {
    this.wanted = true
    this.attempt = 0
    this.open()
    // A powered-off ESP32 never sends a TCP close, so the browser can sit on a dead socket for minutes.
    // Silence (or a hung connect) longer than DEAD_MS counts as a drop.
    this.watchdog = setInterval(() => {
      if (this.ws && Date.now() - this.lastSeen > DEAD_MS) this.drop(`No frames for ${DEAD_MS / 1000} s`)
    }, 1000)
  }

  disconnect() {
    this.wanted = false
    clearTimeout(this.retryTimer)
    clearInterval(this.watchdog)
    this.detach()
    this.onStatus('disconnected', 'Disconnected')
  }

  requestCapture() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ cmd: 'capture' }))
  }

  private open() {
    this.onStatus('connecting')
    this.lastSeen = Date.now()
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (e) {
      this.wanted = false
      clearInterval(this.watchdog)
      this.onStatus('disconnected', `Cannot open ${this.url}: ${(e as Error).message}`)
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.attempt = 0
      this.lastSeen = Date.now()
      this.onStatus('connected', `Connected to ${this.url}`)
    }
    ws.onmessage = (e) => {
      this.lastSeen = Date.now()
      if (typeof e.data === 'string') this.onMessage(e.data)
    }
    ws.onclose = () => this.drop('Connection closed')
  }

  private detach() {
    const ws = this.ws
    this.ws = null
    if (!ws) return
    ws.onopen = ws.onmessage = ws.onclose = null
    ws.close()
  }

  private drop(reason: string) {
    this.detach()
    if (!this.wanted) return
    const delay = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)]
    this.onStatus('connecting', `${reason}. Retrying in ${delay / 1000} s`)
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => this.open(), delay)
  }
}
