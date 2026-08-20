import type { ReactNode } from 'react'
import { useLive } from '@/lib/live'
import { href, type Route } from '@/lib/router'
import { fmtAgo } from '@/lib/format'
import { useTheme } from '@/lib/theme'

const NAV: { route: Route; label: string; phase?: string }[] = [
  { route: { name: 'now' }, label: 'Now' },
  { route: { name: 'cost' }, label: 'Cost' },
  { route: { name: 'history' }, label: 'History' },
  { route: { name: 'tasks' }, label: 'Tasks' },
  { route: { name: 'graph' }, label: 'Graph' },
]

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const live = useLive()
  const active = (r: Route) => (r.name === route.name) || (r.name === 'now' && route.name === 'session')
  return (
    <div className="min-h-screen flex flex-col">
      <header className="h-10 border-b border-border bg-panel flex items-center px-3 gap-4 sticky top-0 z-10">
        <a href="#/" className="flex items-center gap-2 text-fg no-underline hover:no-underline">
          <svg width="16" height="16" viewBox="0 0 32 32" aria-hidden><path d="M6 22 L16 8 L26 22 Z" fill="none" stroke="var(--color-accent)" strokeWidth="3" strokeLinejoin="round" /><rect x="6" y="22" width="20" height="3" fill="var(--color-accent)" /></svg>
          <span className="font-medium tracking-wide text-[13px]">caprock</span>
          <span className="text-fg-faint text-[11px] hidden sm:inline">mission control</span>
        </a>
        <nav className="flex items-center gap-1 ml-2">
          {NAV.map((n) => (
            <a key={n.label} href={href(n.route)}
              className={`px-2 py-1 rounded-sm text-[12px] no-underline hover:no-underline ${active(n.route) ? 'bg-panel-2 text-fg' : 'text-fg-muted hover:text-fg'}`}>
              {n.label}
              {n.phase && <span className="ml-1 text-[9px] uppercase tracking-wider text-fg-faint">{n.phase}</span>}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-[11px] text-fg-muted">
          <ConnDot state={live.conn} lastFrameAt={live.lastFrameAt} />
          <ThemeToggle />
          <a href="#/settings" className="text-fg-muted hover:text-fg no-underline">status</a>
        </div>
      </header>
      <main className="flex-1 p-3 max-w-[1600px] w-full mx-auto">{children}</main>
    </div>
  )
}

function ThemeToggle() {
  const [theme, toggle] = useTheme()
  const dark = theme === 'dark'
  return (
    <button
      type="button"
      onClick={toggle}
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="text-fg-muted hover:text-fg inline-flex items-center"
    >
      {dark ? (
        // sun (click for light)
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
        </svg>
      ) : (
        // moon (click for dark)
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  )
}

function ConnDot({ state, lastFrameAt }: { state: 'connecting' | 'open' | 'closed'; lastFrameAt: number }) {
  const cls = state === 'open' ? 'bg-ok' : state === 'connecting' ? 'bg-warn' : 'bg-danger'
  const label = state === 'open' ? `live · ${lastFrameAt ? fmtAgo(lastFrameAt) : 'connected'}` : state === 'connecting' ? 'connecting…' : 'disconnected — reconnecting'
  return (
    <span className="inline-flex items-center gap-1.5" title="WebSocket /v1/live">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`} />
      <span className="num">{label}</span>
    </span>
  )
}
