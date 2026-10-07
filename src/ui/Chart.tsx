import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { SENSORS, SENSOR_LABEL, type Sensor } from '../config'
import { baselineSegs, captureSpans, type Series } from '../state/series'
import { clock, mmss } from './format'

export type Win = 60 | 300 | 900 | 0 // seconds, 0 = all

const HEIGHT = 400
const DASH: Record<Sensor, number[]> = { mq3: [], mq135: [7, 3], mq7: [2, 3] }
const FONT = '"Manrope Variable", system-ui, sans-serif'

const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
const columns = (s: Series): uPlot.AlignedData => [s.x, s.y.mq3, s.y.mq135, s.y.mq7]

type Props = { series: Series; version: number; win: Win; autoY: boolean; paused: boolean; zoomable: boolean }

/** Remount (key) on theme change: colours are read from CSS variables at creation. */
export function Chart({ series, version, win, autoY, paused, zoomable }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const latest = useRef({ series, autoY })
  latest.current = { series, autoY }

  useEffect(() => {
    const el = box.current!
    const px = uPlot.pxRatio
    const muted = cssVar('--muted')
    const grid = cssVar('--grid')
    const shade = cssVar('--band')
    const accent = cssVar('--accent')
    const colors = SENSORS.map((_, i) => cssVar(`--s${i + 1}`))
    const axis = { stroke: muted, font: `11px ${FONT}`, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1, size: 4 } }
    const canvasFont = `700 ${11 * px}px ${FONT}`

    const clipToPlot = (u: uPlot) => {
      const { ctx, bbox } = u
      ctx.save()
      ctx.beginPath()
      ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height)
      ctx.clip()
    }
    const lastX = () => latest.current.series.x.at(-1) ?? 0

    const drawSpans = (u: uPlot) => {
      const { ctx, bbox } = u
      clipToPlot(u)
      ctx.font = canvasFont
      ctx.textBaseline = 'top'
      const rowEnds: number[] = [] // stagger labels of captures that sit close together
      for (const sp of captureSpans(latest.current.series)) {
        const x0 = u.valToPos(sp.start, 'x', true)
        const x1 = u.valToPos(sp.end ?? lastX(), 'x', true)
        ctx.fillStyle = shade
        ctx.fillRect(x0, bbox.top, Math.max(px, x1 - x0), bbox.height)
        const text = sp.n != null ? `Capture ${sp.n}` : 'Capturing'
        const lx = x0 + 3 * px
        let row = rowEnds.findIndex((end) => end < lx)
        if (row < 0) row = rowEnds.length
        rowEnds[row] = lx + ctx.measureText(text).width + 6 * px
        ctx.fillStyle = accent
        ctx.fillText(text, lx, bbox.top + (4 + row * 14) * px)
      }
      ctx.restore()
    }

    const drawBaselines = (u: uPlot) => {
      const { ctx } = u
      clipToPlot(u)
      ctx.lineWidth = px
      ctx.setLineDash([4 * px, 4 * px])
      for (const seg of baselineSegs(latest.current.series)) {
        const x0 = u.valToPos(seg.start, 'x', true)
        const x1 = u.valToPos(seg.end ?? lastX(), 'x', true)
        SENSORS.forEach((k, i) => {
          const y = Math.round(u.valToPos(seg.v[k], 'y', true)) + 0.5
          ctx.strokeStyle = colors[i]
          ctx.beginPath()
          ctx.moveTo(x0, y)
          ctx.lineTo(x1, y)
          ctx.stroke()
        })
      }
      ctx.restore()
    }

    // Series names at the right end of each line, so the chart reads in greyscale too.
    const drawEndLabels = (u: uPlot) => {
      const { ctx, bbox } = u
      const s = latest.current.series
      const max = u.scales.x.max ?? Infinity
      const labels: { x: number; y: number; i: number }[] = []
      SENSORS.forEach((k, i) => {
        let j = s.x.length - 1
        while (j >= 0 && (s.x[j] > max || s.y[k][j] == null)) j--
        if (j >= 0) labels.push({ x: u.valToPos(s.x[j], 'x', true), y: u.valToPos(s.y[k][j]!, 'y', true), i })
      })
      labels.sort((a, b) => a.y - b.y)
      const gap = 13 * px
      for (let n = 1; n < labels.length; n++) labels[n].y = Math.max(labels[n].y, labels[n - 1].y + gap)
      ctx.save()
      ctx.font = canvasFont
      ctx.textBaseline = 'middle'
      for (const l of labels) {
        if (l.y < bbox.top || l.y > bbox.top + bbox.height + gap) continue
        ctx.fillStyle = colors[l.i]
        ctx.fillText(SENSOR_LABEL[SENSORS[l.i]], l.x + 6 * px, l.y)
      }
      ctx.restore()
    }

    const volts = (_u: uPlot, v: number | null) => (v == null ? '–' : `${v.toFixed(3)} V`)
    const u = new uPlot(
      {
        width: el.clientWidth,
        height: HEIGHT,
        padding: [12, 64, 0, 0],
        cursor: { drag: { x: zoomable, y: false }, points: { size: 5 } },
        scales: {
          x: { time: false },
          y: {
            range: (_u, min, max) => {
              if (!latest.current.autoY || min == null || max == null) return [0, 5]
              const pad = Math.max((max - min) * 0.1, 0.02)
              return [Math.max(0, min - pad), max + pad]
            },
          },
        },
        axes: [
          { ...axis, values: (_u, splits) => splits.map(mmss), incrs: [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600] },
          { ...axis, label: 'Volts', labelFont: `11px ${FONT}`, labelSize: 18, size: 44 },
        ],
        series: [
          {
            label: 'Time',
            value: (_u, v) => (v == null ? '–' : `${mmss(v)}  (${clock(latest.current.series.t0 + v * 1000)})`),
          },
          ...SENSORS.map((k, i) => ({
            label: SENSOR_LABEL[k],
            stroke: colors[i],
            width: 2,
            dash: DASH[k],
            points: { show: false },
            value: volts,
          })),
        ],
        hooks: { drawClear: [drawSpans], draw: [drawBaselines, drawEndLabels] },
      },
      columns(latest.current.series),
      el,
    )
    plot.current = u
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: HEIGHT }))
    ro.observe(el)
    return () => {
      ro.disconnect()
      u.destroy()
      plot.current = null
    }
  }, [zoomable])

  useEffect(() => {
    const u = plot.current
    if (!u || paused) return
    u.batch(() => {
      u.setData(columns(series), zoomable)
      if (zoomable || !series.x.length) return
      // Fill the window from the left first, then roll; keeps the axis still while data is short.
      const first = series.x[0]
      const last = series.x[series.x.length - 1]
      let min = first
      let max = Math.max(last, first + 1)
      if (win) {
        if (last - first < win) max = first + win
        else min = last - win
      }
      u.setScale('x', { min, max })
    })
  }, [series, version, win, autoY, paused, zoomable])

  return <div ref={box} className="chart" />
}
