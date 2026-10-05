import { expect, it } from 'vitest'
import { describeRatio } from '../config'
import { readingsCsv } from './csv'
import { captureSpans, seriesFrom, type Event, type Reading } from './series'

const T0 = 1_700_000_000_000
const r = (sec: number, state = 'ready'): Reading => ({ t: T0 + sec * 1000, mq3: 0.8, mq135: 1, mq7: 0.6, state })
const v = { mq3: 0.8, mq135: 1, mq7: 0.6 }

it('breaks the line across a dropout longer than 2 s, not across the usual 0.5 s spacing', () => {
  const s = seriesFrom(T0, [r(0), r(0.5), r(1), r(9), r(9.5)], [])
  expect(s.y.mq3).toEqual([0.8, 0.8, 0.8, null, 0.8, 0.8])
  expect(s.x[3]).toBeCloseTo(1.001)
})

it('pairs capture_start with capture into a labelled span', () => {
  const ev: Event[] = [
    { t: T0 + 10_000, kind: 'capture_start' },
    { t: T0 + 15_000, kind: 'capture', n: 1, v, ratio: v },
    { t: T0 + 30_000, kind: 'capture', n: 2, v, ratio: v }, // start missed
    { t: T0 + 40_000, kind: 'capture_start' }, // still open
  ]
  expect(captureSpans(seriesFrom(T0, [], ev))).toEqual([
    { start: 10, end: 15, n: 1 },
    { start: 25, end: 30, n: 2 },
    { start: 40, end: null, n: null },
  ])
})

it('CSV puts each event on the next reading and keeps the columns', () => {
  const meta = { id: 1, name: 'x', start: T0, end: T0 + 2000, source: 'simulated' as const }
  const ev: Event[] = [{ t: T0 + 600, kind: 'baseline', v }, { t: T0 + 5000, kind: 'capture', n: 1, v, ratio: v }]
  const lines = readingsCsv(meta, [r(0), r(0.5), r(1, 'capturing')], ev).replace('﻿', '').trim().split('\r\n')
  expect(lines[0]).toBe('iso_time,elapsed_s,mq3_v,mq135_v,mq7_v,state,event,source')
  expect(lines[1]).toBe(`${new Date(T0).toISOString()},0.000,0.800,1.000,0.600,ready,,simulated`)
  expect(lines[3].split(',').slice(5)).toEqual(['capturing', 'baseline', 'simulated'])
  expect(lines[4].split(',').slice(2)).toEqual(['', '', '', '', 'capture 1', 'simulated'])
})

it('descriptor bins, including the firmware 0 ratio when baseline is near 0 V', () => {
  expect([0.5, 0.9, 1.1, 1.2, 0].map(describeRatio)).toEqual([
    'Below baseline', 'Near baseline', 'Near baseline', 'Above baseline', 'No ratio (baseline near 0 V)',
  ])
})
