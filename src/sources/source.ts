export type ConnStatus = 'disconnected' | 'connecting' | 'connected'

/** Anything that produces device JSON frames. The store sets the two callbacks before connect(). */
export interface DataSource {
  readonly kind: 'device' | 'simulated'
  connect(): void
  disconnect(): void
  /** Start a capture, same as the device's physical button. */
  requestCapture(): void
  /** Restart warm-up and discard the baseline, same as holding the device button for 3 s. */
  requestRestart(): void
  onMessage: (text: string) => void
  onStatus: (status: ConnStatus, note?: string) => void
}
