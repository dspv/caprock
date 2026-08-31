// Small presentational primitives. Every color comes from tokens.css.
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Health } from '@/lib/api'

export function Panel({ title, center, right, children, className = '', onMouseEnter, onMouseLeave }: { title?: ReactNode; center?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; onMouseEnter?: () => void; onMouseLeave?: () => void }) {
  return (
    <section
      className={`border border-border bg-panel rounded-[var(--radius-panel)] shadow-[var(--shadow-panel)] min-w-0 ${className}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {(title || center || right) && (
        // The header sits on panel-2 so chrome reads as a recess rather than
        // as body text with a rule under it.
        <header className="relative flex items-center justify-between px-3 py-2 border-b border-border bg-panel-2/60 rounded-t-[var(--radius-panel)]">
          <h2 className="text-[11px] uppercase tracking-[0.12em] text-fg-muted font-medium">{title}</h2>
          {/* A middle slot for a control that governs the panel rather than
            * annotating it. Absolutely positioned so it centres on the panel,
            * not on the space left over between the title and the right-hand
            * note — those two differ in width, and a control that drifts as
            * the note changes reads as a rendering accident. */}
          {center ? (
            <div className="absolute left-1/2 -translate-x-1/2">{center}</div>
          ) : null}
          <div className="text-[11px] text-fg-muted">{right}</div>
        </header>
      )}
      <div>{children}</div>
    </section>
  )
}

export function Stat({ label, value, sub, tone, size = 'default' }: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'ok' | 'warn' | 'danger' | 'info'
  /** `compact` for reference figures in dense rows; `hero` for the one number
   *  a screen is about. Sized uniformly, a row of six is a list, not a
   *  hierarchy — the eye needs somewhere to land. */
  size?: 'hero' | 'default' | 'compact'
}) {
  const toneCls = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : tone === 'info' ? 'text-info' : 'text-fg'
  const valueCls = size === 'hero' ? 'text-[34px] leading-[1.05]' : size === 'compact' ? 'text-[17px] leading-tight' : 'text-[24px] leading-[1.1]'
  return (
    // A column with the caption pushed to the bottom, so captions line up
    // across a row whatever sits above them. One tile's caption wrapping to two
    // lines used to drag every neighbour's off the shared baseline, which read
    // as text stuck to the underside of a number rather than as a row.
    <div className="flex h-full flex-col px-3 py-2.5 min-w-0">
      <div className="text-[10px] uppercase tracking-[0.12em] text-fg-faint">{label}</div>
      {/* Semibold, not just larger: weight separates a figure from its
       * neighbours without spending a pixel of density, which is what a dense
       * dashboard needs. The product had no semibold anywhere. */}
      <div className={`num font-semibold tracking-[-0.01em] ${valueCls} ${toneCls}`}>{value}</div>
      {sub && <div className="mt-auto pt-1 text-[11px] text-fg-muted num truncate">{sub}</div>}
    </div>
  )
}

export const healthLabel: Record<Health, string> = {
  working: 'working',
  idle: 'idle',
  'waiting-on-you': 'waiting on you',
  looping: 'looping?',
  error: 'error',
  ended: 'ended',
}

export function healthTone(h: Health): 'ok' | 'warn' | 'danger' | 'muted' {
  switch (h) {
    case 'working': return 'ok'
    case 'idle': return 'warn'
    case 'waiting-on-you': return 'warn'
    case 'looping': return 'danger'
    case 'error': return 'danger'
    case 'ended': return 'muted'
  }
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

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mono text-[10px] border border-border-strong rounded-sm px-1 py-[1px] text-fg-muted">{children}</kbd>
}
