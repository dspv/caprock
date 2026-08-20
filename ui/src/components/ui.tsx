// Small presentational primitives. Every color comes from tokens.css.
import type { ReactNode } from 'react'
import type { Health } from '@/lib/api'

export function Panel({ title, right, children, className = '' }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`border border-border bg-panel rounded-[var(--radius-panel)] min-w-0 ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between px-3 py-1.5 border-b border-border">
          <h2 className="text-[11px] uppercase tracking-[0.08em] text-fg-muted font-medium">{title}</h2>
          <div className="text-[11px] text-fg-muted">{right}</div>
        </header>
      )}
      <div>{children}</div>
    </section>
  )
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'info' }) {
  const toneCls = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : tone === 'info' ? 'text-info' : 'text-fg'
  return (
    <div className="px-3 py-2.5 min-w-0">
      <div className="text-[10px] uppercase tracking-[0.08em] text-fg-faint">{label}</div>
      {/* The value is the reason the card exists — it outweighs its own label
       * by more than 2x so a card scans from across the desk, not up close. */}
      <div className={`num text-[22px] leading-[1.15] ${toneCls}`}>{value}</div>
      {sub && <div className="text-[11px] text-fg-muted num truncate">{sub}</div>}
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

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mono text-[10px] border border-border-strong rounded-sm px-1 py-[1px] text-fg-muted">{children}</kbd>
}
