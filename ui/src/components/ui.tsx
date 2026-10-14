// Small presentational primitives. Every color comes from tokens.css.
import { useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode, Ref } from 'react'
import type { Health } from '@/lib/api'

/** Which folded panels are closed, by their `fold` key; kept per viewer. */
export const PANEL_FOLDS_KEY = 'caprock.panel.folds'

function readFolds(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(PANEL_FOLDS_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

// One copy of the folds for the page, so a section's data hook can ask whether
// its panel is open (usePanelOpen) and stop refreshing while it is folded.
const foldSubs = new Set<() => void>()
let folds: Set<string> | null = null
const foldsNow = () => (folds ??= readFolds())
const subscribeFolds = (fn: () => void) => {
  foldSubs.add(fn)
  return () => { foldSubs.delete(fn) }
}

/** Open or closed for one foldable panel, remembered across reloads. */
export function usePanelFold(key: string | undefined): [boolean, () => void] {
  const open = usePanelOpen(key)
  const toggle = () => {
    if (!key) return
    const next = new Set(readFolds())
    if (open) next.add(key)
    else next.delete(key)
    try { localStorage.setItem(PANEL_FOLDS_KEY, JSON.stringify([...next])) } catch { /* this page only */ }
    folds = next
    for (const fn of foldSubs) fn()
  }
  return [open, toggle]
}

/** Whether the panel folded under `key` is open; an unkeyed panel always is. */
export function usePanelOpen(key: string | undefined): boolean {
  const closed = useSyncExternalStore(subscribeFolds, () => !!key && foldsNow().has(key), () => false)
  return !closed
}

/** Forgets the page's copy of the folds, so the next read is storage's (tests). */
export function resetPanelFolds(): void {
  folds = null
}

/**
 * A titled panel. With `fold` (a key unique on the screen) its title folds the
 * body away and back, remembered per viewer (owner, 2026-10-11, translated:
 * "let me hide some blocks").
 */
export function Panel({ title, center, right, children, className = '', onMouseEnter, onMouseLeave, fold, sectionRef }: { title?: ReactNode; center?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; onMouseEnter?: () => void; onMouseLeave?: () => void; fold?: string; sectionRef?: Ref<HTMLElement> }) {
  const [open, toggle] = usePanelFold(fold)
  return (
    <section
      ref={sectionRef}
      className={`border border-border bg-panel rounded-[var(--radius-panel)] shadow-[var(--shadow-panel)] min-w-0 ${className}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-panel-fold={fold}
    >
      {(title || center || right) && (
        // The header sits on panel-2 so chrome reads as a recess rather than
        // as body text with a rule under it.
        <header className={`relative flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2 bg-panel-2/60 ${open ? 'border-b border-border rounded-t-[var(--radius-panel)]' : 'rounded-[var(--radius-panel)]'}`}>
          <h2 className="text-[11px] uppercase tracking-[0.12em] text-fg-muted font-medium">
            {fold ? (
              <button type="button" onClick={toggle} aria-expanded={open} title={open ? 'Fold this panel' : 'Unfold this panel'}
                className="inline-flex items-center gap-1.5 uppercase tracking-[0.12em] hover:text-fg">
                <span aria-hidden className={`inline-block transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}>›</span>
                {title}
              </button>
            ) : title}
          </h2>
          {/* A middle slot for a control that governs the panel rather than
            * annotating it. Absolutely positioned so it centres on the panel,
            * not on the space left over between the title and the right-hand
            * note — those two differ in width, and a control that drifts as
            * the note changes reads as a rendering accident. */}
          {center && open ? (
            // On a phone there is no room to centre it over the title and the
            // note, so it takes its own row underneath instead of covering them.
            <div className="order-last w-full sm:order-none sm:w-auto sm:absolute sm:left-1/2 sm:-translate-x-1/2">{center}</div>
          ) : null}
          <div className="min-w-0 text-[11px] text-fg-muted">{right}</div>
        </header>
      )}
      {open && <div>{children}</div>}
    </section>
  )
}

export function Stat({ label, value, sub, tone, size = 'default', trend }: {
  label: string
  value: ReactNode
  sub?: ReactNode
  /** A small picture under the figure — the Now screen's 14-day trend. */
  trend?: ReactNode
  tone?: 'ok' | 'warn' | 'danger' | 'info'
  /** `compact` for reference figures in dense rows; `hero` for the one number
   *  a screen is about. Sized uniformly, a row of six is a list, not a
   *  hierarchy — the eye needs somewhere to land. */
  size?: 'hero' | 'default' | 'compact'
}) {
  const toneCls = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : tone === 'info' ? 'text-info' : 'text-fg'
  const valueCls = size === 'hero' ? 'text-[34px] leading-[1.05]' : size === 'compact' ? 'text-[22px] leading-tight' : 'text-[28px] leading-[1.1]'
  return (
    // A column with the caption pushed to the bottom, so captions line up
    // across a row whatever sits above them. One tile's caption wrapping to two
    // lines used to drag every neighbour's off the shared baseline, which read
    // as text stuck to the underside of a number rather than as a row.
    //
    // A size container, so the figure can shrink to the tile (statFit).
    <div className="@container flex h-full flex-col px-3 py-2.5 min-w-0">
      <div className="text-[10px] uppercase tracking-[0.12em] text-fg-faint">{label}</div>
      {/* Semibold, not just larger: weight separates a figure from its
       * neighbours without spending a pixel of density, which is what a dense
       * dashboard needs. The product had no semibold anywhere. */}
      <div className={`num font-semibold tracking-[-0.01em] whitespace-nowrap ${valueCls} ${toneCls}`} style={statFit(value, size)}>{value}</div>
      {trend}
      {/* Wraps rather than ending in an ellipsis: a cut
       * "at API list price · not a…" dropped the half that mattered. */}
      {sub && <div className="mt-auto pt-1 text-[11px] leading-snug text-fg-muted num [overflow-wrap:anywhere]">{sub}</div>}
    </div>
  )
}

/** A Stat figure's largest size, per tile size. */
const STAT_MAX_PX = { hero: 34, default: 28, compact: 22 } as const

/**
 * The font size that fits a text figure on one line in its tile: the size's
 * own step, or smaller when the tile is too narrow for every character
 * (testers, 2026-10-12: "$12,793.46" ran into the next tile and lost its
 * leading digits in a narrow window). The figure is mono, so each character
 * is 0.6em wide and the arithmetic is exact; 100cqi is the tile's content
 * width. A node that is not plain text keeps the fixed step.
 */
export function statFit(value: ReactNode, size: 'hero' | 'default' | 'compact' = 'default'): CSSProperties | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const n = String(value).length
  if (n === 0) return undefined
  return { fontSize: `max(12px, min(${STAT_MAX_PX[size]}px, calc(100cqi / ${(n * 0.6).toFixed(2)})))` }
}

const healthLabel: Record<Health, string> = {
  working: 'working',
  idle: 'idle',
  'waiting-on-you': 'waiting on you',
  looping: 'looping?',
  error: 'error',
  ended: 'ended',
}

function healthTone(h: Health): 'ok' | 'warn' | 'danger' | 'muted' {
  switch (h) {
    case 'working': return 'ok'
    case 'idle': return 'warn'
    case 'waiting-on-you': return 'warn'
    case 'looping': return 'danger'
    case 'error': return 'danger'
    case 'ended': return 'muted'
  }
}

/** The session's state as a dot alone, its word for screen readers and on
 *  hover: where a Badge does not fit (the phone's session bar). */
export function HealthDot({ health, className = '' }: { health: Health; className?: string }) {
  const tone = healthTone(health)
  return (
    <span
      role="img"
      aria-label={healthLabel[health]}
      title={healthLabel[health]}
      data-health={health}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : tone === 'danger' ? 'bg-danger' : 'bg-fg-faint'} ${health === 'working' ? 'animate-pulse' : ''} ${className}`}
    />
  )
}

export function Badge({ health }: { health: Health }) {
  const tone = healthTone(health)
  const cls =
    tone === 'ok' ? 'text-ok border-ok/40 bg-ok/10' :
    tone === 'warn' ? 'text-warn border-warn/40 bg-warn/10' :
    tone === 'danger' ? 'text-danger border-danger/40 bg-danger/10' :
    'text-fg-muted border-border bg-panel-2'
  return (
    <span className={`inline-flex items-center gap-1.5 border rounded-sm px-1.5 py-[1px] text-[11px] leading-4 ${cls}`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : tone === 'danger' ? 'bg-danger' : 'bg-fg-faint'} ${health === 'working' ? 'animate-pulse' : ''}`} />
      {healthLabel[health]}
    </span>
  )
}

export function Sparkline({ values, width = 120, height = 24, tone = 'info' }: { values: number[]; width?: number; height?: number; tone?: 'ok' | 'warn' | 'danger' | 'info' | 'accent' }) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden />
  const max = Math.max(...values, 1e-9)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const step = width / (values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * (height - 2) - 1).toFixed(1)}`).join(' ')
  const color = tone === 'ok' ? 'var(--color-ok)' : tone === 'warn' ? 'var(--color-warn)' : tone === 'danger' ? 'var(--color-danger)' : tone === 'accent' ? 'var(--color-accent)' : 'var(--color-info)'
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block" aria-hidden>
      <polyline fill="none" stroke={color} strokeWidth="1.25" points={pts} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <div className="text-fg-muted">{title}</div>
      {children && <div className="text-[12px] text-fg-faint mt-1">{children}</div>}
    </div>
  )
}

/**
 * Skeleton — placeholder rows while data is on its way.
 *
 * Screens used to test `list.length === 0` without asking whether the fetch had
 * finished, so the first paint of every screen announced "No history yet" and
 * then replaced it with real numbers. That reads as "this product has nothing
 * for you", which is the opposite of true and the worst possible first frame.
 * A shape that matches what is coming says "loading" without a spinner.
 */
export function Skeleton({ rows = 3, className = '' }: { rows?: number; className?: string }) {
  return (
    <div className={`px-3 py-2 grid gap-2 ${className}`} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="h-3 rounded-sm bg-panel-2 skeleton-pulse"
          // Vary the widths so it reads as content rather than as a progress bar.
          style={{ width: `${[92, 74, 83, 61, 88][i % 5]}%` }}
        />
      ))}
    </div>
  )
}

/**
 * Copyable — one shell command, click to copy.
 *
 * Deliberately not a "run it for me" button. The commands it carries land
 * branches in a user's repository; executing that from a web page on their
 * behalf is exactly the surface a local-first tool should not open. They copy
 * one line and run it in their own terminal, where they can read it first.
 */
export function Copyable({ command, className = '' }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={`mono text-[12px] bg-panel-2 border border-border px-2 py-0.5 rounded-sm hover:border-border-strong text-fg text-left ${className}`}
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }}
      title="copy to clipboard — run it in your terminal"
    >
      {copied ? 'copied' : `$ ${command}`}
    </button>
  )
}

/**
 * Says that the figures on screen are this browser's last copy, and how old,
 * while the fresh ones are read (lib/swr.ts). Quiet on purpose: the numbers
 * are useful, just not live — and nothing that means "now" is shown from them.
 */
export function StaleNote({ at, now = Date.now(), className = '' }: { at: number; now?: number; className?: string }) {
  if (!at) return null
  const mins = Math.max(0, Math.round((now - at) / 60000))
  const age = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`
  return (
    <span className={`text-[11px] text-fg-faint whitespace-nowrap ${className}`} role="status" title="The last figures this browser kept; fresh ones are being read">
      updated {age} · refreshing
    </span>
  )
}
