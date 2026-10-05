export type ConnStatus = 'disconnected' | 'connecting' | 'connected'

/** Anything that produces device JSON frames. The store sets the two callbacks before connect(). */
export interface DataSource {
  readonly kind: 'device' | 'simulated'
  connect(): void
  disconnect(): void
  /** Start a 5 s capture, same as the device's physical button. */
  requestCapture(): void
  onMessage: (text: string) => void
  onStatus: (status: ConnStatus, note?: string) => void
}
