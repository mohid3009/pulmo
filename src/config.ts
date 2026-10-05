export const SENSORS = ['mq3', 'mq135', 'mq7'] as const
export type Sensor = (typeof SENSORS)[number]
export const SENSOR_LABEL: Record<Sensor, string> = { mq3: 'MQ-3', mq135: 'MQ-135', mq7: 'MQ-7' }
// What each sensor responds to most, per its datasheet. Cross-sensitive; not a measurement of that gas.
export const SENSOR_HINT: Record<Sensor, string> = { mq3: 'alcohol-sensitive', mq135: 'VOC / NH₃-sensitive', mq7: 'CO-sensitive' }

// Display bins for the change in sensor voltage vs baseline. Not clinical thresholds.
export const RATIO_LOW = 0.9
export const RATIO_HIGH = 1.1

export function describeRatio(r: number): string {
  if (!(r > 0)) return 'No ratio (baseline near 0 V)' // firmware sends 0 when baseline <= 0.01 V
  if (r < RATIO_LOW) return 'Below baseline'
  if (r > RATIO_HIGH) return 'Above baseline'
  return 'Near baseline'
}

export const MAX_VOLTS = 5.5
export const GAP_MS = 2000 // break the chart line across dropouts longer than this
export const STALE_MS = 3000 // "No data for 3 s"
export const DEAD_MS = 5000 // no frames this long: drop the socket and reconnect
export const RETRY_MS = [1000, 2000, 5000] // then every 5 s
export const FLUSH_MS = 2000 // recording batch interval
export const DEFAULT_URL = 'ws://192.168.4.1:81'
