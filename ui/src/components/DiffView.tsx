/**
 * One file's diff, unified or side by side, drawn a screenful at a time.
 *
 * Only the rows in view (plus a margin) are in the DOM, so a 5,000-line patch
 * scrolls like a 50-line one (21-app.md § The scrolling rule). Unified rows
 * are one line each and scroll sideways together. Side by side, each half is
 * half the width and its lines wrap; the font is monospaced, so how many rows
 * a line wraps to is known from its length before it is drawn, and the
 * window of rows is still computed rather than measured. Lines past
 * LONG_LINE characters are cut with a note.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { splitRows, unifiedRows, type SideCell, type SplitRow, type UnifiedRow } from '@/lib/changes'

export const ROW_HEIGHT = 18
/** Pixels drawn above and below the view. */
const OVERSCAN_PX = 600
const LONG_LINE = 2000
const TAB = 4

export type DiffLayout = 'unified' | 'split'

const TONE: Record<string, string> = {
  add: 'bg-ok/12',
  del: 'bg-danger/12',
  ctx: '',
  hunk: 'bg-info/8 text-info',
  meta: 'text-fg-faint',
}

function cut(text: string): string {
  return text.length > LONG_LINE ? `${text.slice(0, LONG_LINE)} … ${(text.length - LONG_LINE).toLocaleString()} more characters` : text
}

/** Columns a line takes, tabs at their width. */
function columns(text: string): number {
  const t = cut(text)
  let n = t.length
  for (let i = t.indexOf('\t'); i >= 0; i = t.indexOf('\t', i + 1)) n += TAB - 1
  return n
}

/** The first index whose offset is past y (offsets ascending, offsets[0] = 0). */
function rowAt(offsets: Float64Array, y: number): number {
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid + 1]! <= y) lo = mid + 1
    else hi = mid
  }
  return lo
}

export interface DiffViewProps {
  patch: string
  layout: DiffLayout
  /** Draws a button on each hunk header: stage or unstage that hunk. */
  hunkAction?: { label: string; run: (index: number) => void; busy?: boolean }
  /** Scrolled back to the top when this changes (a new file). */
  resetKey?: string
}

export const DiffView = memo(function DiffView({ patch, layout, hunkAction, resetKey }: DiffViewProps) {
  const unified = useMemo(() => unifiedRows(patch), [patch])
  const rows: (UnifiedRow | SplitRow)[] = useMemo(() => (layout === 'split' ? splitRows(unified) : unified), [layout, unified])
  const digits = useMemo(() => String(unified.reduce((m, r) => Math.max(m, r.old ?? 0, r.new ?? 0), 0)).length, [unified])
  const longest = useMemo(() => Math.min(LONG_LINE + 30, unified.reduce((m, r) => Math.max(m, r.text.length), 0)), [unified])

  const box = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const [top, setTop] = useState(0)
  const [size, setSize] = useState({ width: 900, height: 600 })
  const [ch, setCh] = useState(7.2)
  const frame = useRef(0)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setSize({ width: el.clientWidth || 900, height: el.clientHeight || 600 })
    measure()
    const w = probe.current?.getBoundingClientRect().width
    if (w) setCh(w / 100)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (box.current) box.current.scrollTop = 0
    setTop(0)
  }, [resetKey])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const onScroll = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => setTop(box.current?.scrollTop ?? 0))
  }, [])

  // Pixel widths: the gutter is the widest line number plus padding (0.9rem).
  const gutterPx = digits * ch + 14.4
  const halfPx = Math.max(120, (size.width - 1) / 2)
  // Characters that fit on one row of a half: its width less the gutter and
  // the right padding (pr-4).
  const perRow = Math.max(8, Math.floor((halfPx - gutterPx - 16) / ch))

  const offsets = useMemo(() => {
    const out = new Float64Array(rows.length + 1)
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!
      let lines = 1
      if (layout === 'split' && r.kind === 'line') {
        const s = r as Extract<SplitRow, { kind: 'line' }>
        lines = Math.max(1, Math.ceil(columns(s.left?.text ?? '') / perRow), Math.ceil(columns(s.right?.text ?? '') / perRow))
      }
      out[i + 1] = out[i]! + lines * ROW_HEIGHT
    }
    return out
  }, [rows, layout, perRow])

  const total = offsets[rows.length]!
  const first = rowAt(offsets, Math.max(0, top - OVERSCAN_PX))
  const last = Math.min(rows.length, rowAt(offsets, top + size.height + OVERSCAN_PX) + 1)
  const gutter = `${gutterPx}px`
  // Unified: one column of text as wide as the longest line, so the
  // sideways scroll does not jump as rows come and go.
  const width = layout === 'split' ? '100%' : `${2 * gutterPx + (longest + 3) * ch + 24}px`

  return (
    <div
      ref={box}
      onScroll={onScroll}
      tabIndex={0}
      role="region"
      aria-label="Diff"
      className={`app-scroll mono relative h-full min-h-0 text-[12px] leading-[18px] outline-none [tab-size:4] ${layout === 'split' ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto'}`}
    >
      <span ref={probe} aria-hidden className="pointer-events-none invisible absolute whitespace-pre">{'0'.repeat(100)}</span>
      <div style={{ height: total, minWidth: '100%', width }} className="relative">
        <div style={{ transform: `translateY(${offsets[first]}px)` }}>
          {rows.slice(first, last).map((r, i) => {
            const key = first + i
            const h = offsets[key + 1]! - offsets[key]!
            if (r.kind === 'hunk' || r.kind === 'meta') {
              return (
                <div key={key} className={`flex h-[18px] items-center overflow-hidden whitespace-pre ${TONE[r.kind]}`}>
                  {r.kind === 'hunk' && hunkAction && (
                    <button
                      type="button"
                      disabled={hunkAction.busy}
                      onClick={() => hunkAction.run(r.hunk)}
                      className="sticky left-0 z-[1] mx-1 h-[16px] shrink-0 rounded-[4px] border border-[var(--app-hairline-strong)] bg-panel px-1.5 font-sans text-[10.5px] leading-none text-fg-muted hover:text-fg disabled:opacity-50"
                    >
                      {hunkAction.label}
                    </button>
                  )}
                  <span className="px-2">{r.text}</span>
                </div>
              )
            }
            if (layout === 'split') {
              const s = r as Extract<SplitRow, { kind: 'line' }>
              return (
                <div key={key} className="flex overflow-hidden" style={{ height: h }}>
                  <Side cell={s.left} gutter={gutter} />
                  <div className="w-px shrink-0 bg-[var(--app-hairline)]" />
                  <Side cell={s.right} gutter={gutter} />
                </div>
              )
            }
            const u = r as UnifiedRow
            return (
              <div key={key} className={`flex h-[18px] ${TONE[u.kind]}`}>
                <span className="shrink-0 select-none pr-1.5 text-right text-fg-faint" style={{ width: gutter }}>{u.old ?? ''}</span>
                <span className="shrink-0 select-none pr-2 text-right text-fg-faint" style={{ width: gutter }}>{u.new ?? ''}</span>
                <span className={`select-none pr-1 ${u.kind === 'add' ? 'text-ok' : u.kind === 'del' ? 'text-danger' : 'text-fg-faint'}`}>{u.kind === 'add' ? '+' : u.kind === 'del' ? '−' : ' '}</span>
                <span className={`whitespace-pre pr-4 ${u.kind === 'ctx' ? 'text-fg-muted' : 'text-fg'}`}>{cut(u.text)}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
})

/** One half of a side-by-side row; it wraps by characters, so its height is what the row was given. */
function Side({ cell, gutter }: { cell?: SideCell; gutter: string }) {
  if (!cell) return <div className="min-w-0 flex-1 basis-0 bg-[var(--app-row-hover)]" />
  return (
    <div className={`flex min-w-0 flex-1 basis-0 ${TONE[cell.kind]}`}>
      <span className="shrink-0 select-none pr-2 text-right text-fg-faint" style={{ width: gutter }}>{cell.n || ''}</span>
      <span className={`min-w-0 flex-1 whitespace-pre-wrap break-all pr-4 ${cell.kind === 'ctx' ? 'text-fg-muted' : 'text-fg'}`}>{cut(cell.text)}</span>
    </div>
  )
}
