import { describe, expect, it } from 'vitest'
import { isReboot, parseFrame } from './parse'

const live = (o: object = {}) =>
  JSON.stringify({ type: 'live', ms: 123456, mq3: 0.812, mq135: 1.02, mq7: 0.655, state: 'ready', warmupLeft: 0, ...o })

describe('parseFrame', () => {
  it('hello', () => {
    expect(parseFrame('{"type":"hello","state":"warmup","hasBaseline":false}')).toEqual({
      msg: { type: 'hello', state: 'warmup', hasBaseline: false },
    })
  })

  it('live, ignoring unknown fields', () => {
    expect(parseFrame(live({ extra: 'x' }))).toEqual({
      msg: { type: 'live', ms: 123456, mq3: 0.812, mq135: 1.02, mq7: 0.655, state: 'ready', warmupLeft: 0 },
    })
  })

  it('baseline', () => {
    expect(parseFrame('{"type":"baseline","mq3":0.8,"mq135":1.0,"mq7":0.6}')).toEqual({
      msg: { type: 'baseline', mq3: 0.8, mq135: 1.0, mq7: 0.6 },
    })
  })

  it('capture', () => {
    const f = '{"type":"capture","n":2,"mq3":1.0,"mq135":1.5,"mq7":0.7,"ratioMq3":1.25,"ratioMq135":1.5,"ratioMq7":1.1}'
    expect(parseFrame(f)).toEqual({
      msg: { type: 'capture', n: 2, mq3: 1.0, mq135: 1.5, mq7: 0.7, ratio: { mq3: 1.25, mq135: 1.5, mq7: 1.1 } },
    })
  })

  it('unknown type is ignored', () => {
    expect(parseFrame('{"type":"telemetry","x":1}')).toBeNull()
  })

  it('malformed JSON returns an error, never throws', () => {
    for (const f of ['{"type":"live",', '', 'null', '[1,2]', '42']) expect(parseFrame(f)).toHaveProperty('error')
  })

  it('non-numeric value drops the live frame', () => {
    expect(parseFrame(live({ mq7: '0.6' }))).toHaveProperty('error')
    expect(parseFrame(live({ mq3: null }))).toHaveProperty('error')
    expect(parseFrame(live({ ms: 'x' }))).toHaveProperty('error')
  })

  it('out-of-range value drops the live frame', () => {
    expect(parseFrame(live({ mq135: 5.6 }))).toHaveProperty('error')
    expect(parseFrame(live({ mq3: -0.01 }))).toHaveProperty('error')
    expect(parseFrame(live({ mq3: 5.5 }))).toHaveProperty('msg')
  })
})

describe('isReboot', () => {
  it('ms going backwards is a reboot', () => {
    expect(isReboot(null, 500)).toBe(false)
    expect(isReboot(1000, 1500)).toBe(false)
    expect(isReboot(90000, 500)).toBe(true)
  })
})
