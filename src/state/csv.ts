import { describeRatio, SENSORS, SENSOR_LABEL } from '../config'
import type { SessionMeta } from './db'
import { captures, type Event, type Reading } from './series'

// Quote when needed; prefix text that Excel would run as a formula.
const cell = (v: string | number) => {
  let s = String(v)
  if (/^[=+\-@]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const toCsv = (rows: (string | number)[][]) => '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'

const label = (e: Event) => (e.kind === 'baseline' ? 'baseline' : e.kind === 'capture' ? `capture ${e.n}` : 'capture start')

export function readingsCsv(m: SessionMeta, readings: Reading[], events: Event[]) {
  const iso = (t: number) => new Date(t).toISOString()
  const el = (t: number) => ((t - m.start) / 1000).toFixed(3)
  const ev = [...events].sort((a, b) => a.t - b.t)
  const rows: (string | number)[][] = [['iso_time', 'elapsed_s', 'mq3_v', 'mq135_v', 'mq7_v', 'state', 'event', 'source']]
  let i = 0
  for (const r of readings) {
    // Each event goes on the first reading at or after it.
    const here: string[] = []
    while (i < ev.length && ev[i].t <= r.t) here.push(label(ev[i++]))
    rows.push([iso(r.t), el(r.t), r.mq3.toFixed(3), r.mq135.toFixed(3), r.mq7.toFixed(3), r.state, here.join('; '), m.source])
  }
  for (; i < ev.length; i++) rows.push([iso(ev[i].t), el(ev[i].t), '', '', '', '', label(ev[i]), m.source])
  return toCsv(rows)
}

export function capturesCsv(m: SessionMeta, events: Event[]) {
  const rows: (string | number)[][] = [['capture', 'iso_time', 'sensor', 'volts', 'ratio_vs_baseline', 'descriptor', 'source']]
  for (const c of captures(events))
    for (const k of SENSORS)
      rows.push([c.n, new Date(c.t).toISOString(), SENSOR_LABEL[k], c.v[k].toFixed(3), c.ratio[k].toFixed(3), describeRatio(c.ratio[k]), m.source])
  return toCsv(rows)
}

export function download(filename: string, text: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
