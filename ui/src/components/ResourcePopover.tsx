/**
 * The status bar's resource popover (.ai/04-ui.md § Status strip; owner,
 * 2026-10-15, translated: "I want a popover here that shows graphs of
 * resource consumption"). Hovering, focusing or clicking *agent cpu … ram …*
 * opens it: CPU and memory over the last 15 minutes or hour for the agent in
 * front, every session together and Caprock itself, each with its latest
 * figure, peak and average, and the sessions using the most right now, each
 * a way to its tab.
 *
 * Costs nothing while closed: it is drawn only while open, its history is
 * the daemon's ring (lib/resourceHistory.ts) fetched on open and extended by
 * the `resources` frames the bar already gets, and the charts are a few SVG
 * paths drawn again only when a sample lands or the pointer moves to another
 * sample. Nothing animates.
 */
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { SessionSummary } from '@/lib/api'
import { sessionTitle } from '@/lib/sidebar'
import { fmtCPU, fmtMem, useResources } from '@/lib/resources'
import {
  WINDOWS, currentHistory, fmtMetric, openHistory, pointsOf, stats, subscribeHistory, topConsumers,
  type Metric, type Point, type ResourceHistory, type Series, type WindowKey,
} from '@/lib/resourceHistory'
import { CloseIcon } from './AppIcons'

const W = 332
const H = 58

interface Line {
  key: 'front' | 'all' | 'caprock'
  label: string
  color: string
  dash?: string
  area?: boolean
  series: Series | undefined
}

function linesFor(h: ResourceHistory, sessionId: string): Line[] {
  return [
    { key: 'front', label: 'This agent', color: 'var(--color-accent)', area: true, series: h.sessions[sessionId] },
    { key: 'all', label: 'All sessions', color: 'var(--color-merged)', series: h.all },
    { key: 'caprock', label: 'Caprock', color: 'var(--color-fg-muted)', dash: '3 2', series: h.caprock },
  ]
}

/** A round top for the y scale: 10/25/50/100… for CPU, a power-of-two-ish step for memory. */
export function niceMax(metric: Metric, peak: number): number {
  if (metric === 'cpu') {
    for (const m of [10, 25, 50, 100, 200, 400, 800, 1600, 3200]) if (peak <= m) return m
    return Math.ceil(peak / 1000) * 1000
  }
  const mib = 2 ** 20
  for (const m of [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768]) if (peak <= m * mib) return m * mib
  return Math.ceil(peak / (2 ** 30)) * 2 ** 30
}

/** The path of one series: separate runs where a sample is missing or the meter was not sampling. */
function pathOf(pts: Point[], x: (t: number) => number, y: (v: number) => number, gapMs: number, area: boolean): string {
  let d = ''
  let run: Point[] = []
  const flush = () => {
    if (run.length === 0) return
    const line = run.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.v!).toFixed(1)}`).join('')
    if (run.length === 1) d += `${line}h1.5`
    else d += area ? `${line}L${x(run[run.length - 1]!.at).toFixed(1)},${H}L${x(run[0]!.at).toFixed(1)},${H}Z` : line
    run = []
  }
  let prev: Point | undefined
  for (const p of pts) {
    if (p.v === null || (prev && p.at - prev.at > gapMs)) flush()
    if (p.v !== null) run.push(p)
    prev = p
  }
  flush()
  return d
}

function Chart({ metric, h, lines, ms, now, hover, onHover }: {
  metric: Metric; h: ResourceHistory; lines: Line[]; ms: number; now: number
  hover: number | undefined; onHover: (at: number | undefined) => void
}) {
  const pts = lines.map((l) => pointsOf(h, l.series, metric, ms, now))
  const peak = Math.max(0, ...pts.flat().map((p) => p.v ?? 0))
  const top = niceMax(metric, peak)
  const x = (t: number) => ((t - (now - ms)) / ms) * W
  const y = (v: number) => H - 1 - (Math.min(v, top) / top) * (H - 4)
  const gap = Math.max(2.5 * h.interval_s * 1000, 12_000)
  const ats = h.at.filter((t) => t >= now - ms)
  const move = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (ats.length === 0) return
    const r = e.currentTarget.getBoundingClientRect()
    const t = now - ms + ((e.clientX - r.left) / r.width) * ms
    let best = ats[0]!
    for (const a of ats) if (Math.abs(a - t) < Math.abs(best - t)) best = a
    if (best !== hover) onHover(best)
  }
  return (
    <div className="relative">
      <svg data-resource-chart={metric} width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[58px] w-full overflow-visible"
        onMouseMove={move} onMouseLeave={() => onHover(undefined)} role="img"
        aria-label={`${metric === 'cpu' ? 'CPU' : 'Memory'} over the last ${WINDOWS.find((w) => w.ms === ms)?.label ?? ''}`}>
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--app-hairline-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <line x1="0" x2={W} y1={y(top)} y2={y(top)} stroke="var(--app-hairline)" strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
        {lines.map((l, i) => l.area && (
          <path key={`${l.key}-area`} d={pathOf(pts[i]!, x, y, gap, true)} fill={l.color} fillOpacity="0.16" stroke="none" />
        ))}
        {lines.slice().reverse().map((l) => {
          const i = lines.indexOf(l)
          return <path key={l.key} data-line={l.key} d={pathOf(pts[i]!, x, y, gap, false)} fill="none" stroke={l.color} strokeWidth={l.area ? 1.75 : 1.25}
            strokeDasharray={l.dash} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        })}
        {hover !== undefined && <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} stroke="var(--color-fg-faint)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      </svg>
      <span className="num pointer-events-none absolute left-0 top-[-2px] text-[10px] leading-none text-fg-faint">{fmtMetric(metric, top)}</span>
    </div>
  )
}

function valueAt(h: ResourceHistory, s: Series | undefined, metric: Metric, at: number): number | null {
  const i = h.at.indexOf(at)
  return i < 0 || !s ? null : s[metric][i] ?? null
}

function Block({ metric, title, h, lines, ms, now, hover, onHover }: {
  metric: Metric; title: string; h: ResourceHistory; lines: Line[]; ms: number; now: number
  hover: number | undefined; onHover: (at: number | undefined) => void
}) {
  return (
    <section data-resource-block={metric} className="grid gap-1.5">
      <div className="flex items-baseline justify-between text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">
        <span>{title}</span>
        {metric === 'cpu' && <span className="font-normal normal-case tracking-normal">100% is one core</span>}
      </div>
      <Chart metric={metric} h={h} lines={lines} ms={ms} now={now} hover={hover} onHover={onHover} />
      <div className="grid grid-cols-[minmax(0,1fr)_repeat(3,4.5rem)] items-baseline gap-x-2 gap-y-[2px] text-[11.5px]">
        <span />
        <span className="text-right text-[10.5px] text-fg-faint">{hover !== undefined ? clock(hover) : 'now'}</span>
        <span className="text-right text-[10.5px] text-fg-faint">peak</span>
        <span className="text-right text-[10.5px] text-fg-faint">average</span>
        {lines.map((l) => {
          const st = stats(pointsOf(h, l.series, metric, ms, now))
          const shown = hover !== undefined ? valueAt(h, l.series, metric, hover) : st.now
          return (
            <div key={l.key} data-resource-row={l.key} className="contents">
              <span className="flex min-w-0 items-center gap-1.5 truncate text-fg-muted">
                <svg aria-hidden width="12" height="6" className="shrink-0"><line x1="0" x2="12" y1="3" y2="3" stroke={l.color} strokeWidth="2" strokeDasharray={l.dash} /></svg>
                {l.label}
              </span>
              <span className="num text-right text-fg">{fmtMetric(metric, shown)}</span>
              <span className="num text-right text-fg-muted">{fmtMetric(metric, st.peak)}</span>
              <span className="num text-right text-fg-muted">{fmtMetric(metric, st.avg)}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function useHistory(): ResourceHistory {
  useEffect(() => openHistory(), [])
  return useSyncExternalStore(subscribeHistory, currentHistory)
}

/** The popover's body; `anchor` is the status bar's figures it opens from. */
export function ResourcePopover({ sessionId, sessions, anchor, onOpenSession, onClose, onEnter, onLeave }: {
  sessionId: string
  sessions?: SessionSummary[]
  anchor: RefObject<HTMLElement | null>
  onOpenSession?: (id: string) => void
  /** `back`: hand the focus back to the figures (Escape, the close button), not when a row took the user elsewhere. */
  onClose: (back: boolean) => void
  onEnter?: () => void
  onLeave?: () => void
}) {
  const h = useHistory()
  const rep = useResources()
  const [win, setWin] = useState<WindowKey>('15m')
  const [hover, setHover] = useState<number>()
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect()
    if (!r) return
    const vw = window.innerWidth
    const width = Math.min(380, vw - 16)
    const left = Math.max(8, Math.min(r.left, vw - width - 8))
    setPos({ left, bottom: window.innerHeight - r.top + 6, width, maxHeight: r.top - 14 })
  }, [anchor])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(true) } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const ms = WINDOWS.find((w) => w.key === win)!.ms
  // The charts' right edge: the newest sample, so the line ends at the edge
  // and nothing moves between samples.
  const now = h.at[h.at.length - 1] ?? rep?.at ?? Date.now()
  const lines = useMemo(() => linesFor(h, sessionId), [h, sessionId])
  const names = useMemo(() => new Map((sessions ?? []).map((s) => [s.session_id, sessionTitle(s)])), [sessions])
  const top = topConsumers(rep?.sessions ?? [])
  const first = h.at[0]
  const partial = first === undefined || first > now - ms + 2 * h.interval_s * 1000
  return createPortal(
    <div role="dialog" aria-label="Resources" data-resource-popover onMouseEnter={onEnter} onMouseLeave={onLeave}
      style={{ position: 'fixed', zIndex: 60, ...pos }}
      className="grid gap-3 overflow-y-auto rounded-[10px] border border-border-strong bg-panel p-3 text-[11.5px] text-fg shadow-lg">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[13px] font-semibold">Resources</span>
        <div role="group" aria-label="Period" className="flex shrink-0 items-center rounded-[6px] border border-[var(--app-hairline)] p-px">
          {WINDOWS.map((w) => (
            <button key={w.key} type="button" aria-pressed={w.key === win} onClick={() => setWin(w.key)}
              className={`grid h-[18px] place-items-center rounded-[5px] px-1.5 text-[11px] leading-[16px] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${w.key === win ? 'bg-panel-2 font-medium text-fg' : 'text-fg-muted hover:text-fg'}`}>
              {w.label}
            </button>
          ))}
        </div>
        <button type="button" aria-label="Close" title="Close (Esc)" onClick={() => onClose(true)}
          className="-mr-1 grid h-6 w-6 place-items-center rounded-md text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
          <CloseIcon size={13} />
        </button>
      </div>
      <Block metric="cpu" title="CPU" h={h} lines={lines} ms={ms} now={now} hover={hover} onHover={setHover} />
      <Block metric="mem" title="Memory" h={h} lines={lines} ms={ms} now={now} hover={hover} onHover={setHover} />
      {top.length > 0 && (
        <section className="grid gap-1" aria-label="Using the most now">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">Using the most now</div>
          <ul className="grid gap-px">
            {top.map((s) => (
              <li key={s.session_id}>
                <button type="button" data-consumer={s.session_id} disabled={!onOpenSession}
                  onClick={() => { onClose(false); onOpenSession?.(s.session_id) }}
                  title={s.top.map((p) => `${p.name} · ${fmtCPU(p.cpu_pct, s.warm)} · ${fmtMem(p.mem_bytes)}`).join('\n')}
                  className="grid w-full grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-baseline gap-x-2 rounded-[5px] px-1 py-[3px] text-left hover:bg-[var(--app-row-hover)] disabled:cursor-default disabled:hover:bg-transparent">
                  <span className="min-w-0 truncate text-fg">
                    {names.get(s.session_id) ?? s.top[0]?.name ?? `pid ${s.pid}`}
                    {s.session_id === sessionId && <span className="text-fg-faint"> · in front</span>}
                  </span>
                  <span className={`num text-right ${s.hot ? 'text-warn' : 'text-fg-muted'}`}>{fmtCPU(s.cpu_pct, s.warm)}</span>
                  <span className="num text-right text-fg-muted">{fmtMem(s.mem_bytes)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {partial && (
        <p data-history-note className="text-[11px] text-fg-faint">
          {first === undefined ? 'No samples yet.' : `Since ${clock(first).slice(0, 5)}.`} Caprock measures every {h.interval_s} s only while one of its windows is open, so the history starts then and has gaps where none was.
        </p>
      )}
    </div>,
    document.body,
  )
}
