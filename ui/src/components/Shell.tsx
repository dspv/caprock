import type { ReactNode } from 'react'
import { useLive } from '@/lib/live'
import { href, type Route } from '@/lib/router'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { useTheme } from '@/lib/theme'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { PlanChip, usePlan } from '@/components/PlanPicker'
import { FeedbackButton } from '@/components/Feedback'
import { SiteFooter } from '@/components/SiteFooter'

const NAV: { route: Route; label: string; phase?: string }[] = [
  { route: { name: 'now' }, label: 'Now' },
  { route: { name: 'cost' }, label: 'Cost' },
  // 'History' read as a log of past sessions. The screen is the opposite: one
  // set of lifetime totals — every session, every day, what it all cost —
  // which is the most quotable number the product has and was hidden behind a
  // word that promised a list. The panel inside it already said 'Lifetime'.
  { route: { name: 'history' }, label: 'Lifetime' },
  { route: { name: 'notes' }, label: 'Answers' },
  { route: { name: 'tasks' }, label: 'Tasks' },
]
// The graph is deliberately not in NAV. Without a running orchestrator it can
// only draw session ids around a hub — topology, not work — which costs a
// permanent nav slot to say nothing. The route stays live at #/graph and Tasks
// links to it while an orchestration is actually running.

/** A human name for the current route, for a feedback report. */
function screenName(r: Route): string {
  switch (r.name) {
    case 'now': return 'Now'
    case 'session': return 'Session detail'
    case 'cost': return 'Cost'
    case 'history': return 'Lifetime'
    case 'tasks': return 'Tasks'
    case 'graph': return 'Graph'
    case 'notes': return 'Answers'
    case 'settings': return 'Status'
  }
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const live = useLive()
  const [plan, savePlan] = usePlan()
  const active = (r: Route) => (r.name === route.name) || (r.name === 'now' && route.name === 'session')
  return (
    <div className="min-h-screen flex flex-col">
      <header className="h-10 border-b border-border bg-panel flex items-center px-3 gap-4 sticky top-0 z-10">
        <a href="#/" className="flex items-center gap-2 text-fg no-underline hover:no-underline">
          <svg width="16" height="16" viewBox="0 0 32 32" aria-hidden><path d="M6 22 L16 8 L26 22 Z" fill="none" stroke="var(--color-accent)" strokeWidth="3" strokeLinejoin="round" /><rect x="6" y="22" width="20" height="3" fill="var(--color-accent)" /></svg>
          <span className="font-medium tracking-wide text-[13px]">caprock</span>
          <span className="text-fg-faint text-[11px] hidden sm:inline">mission control</span>
        </a>
        {/* A filled pill for the current screen — the same control the agent
          * filter on Now uses, and it works for the same reason: a solid
          * accent block is read before any text is. The previous state was
          * `bg-panel-2` against the header's own `bg-panel`, a few percent of
          * lightness apart, with the label one step of grey brighter; on open
          * there was nothing saying which screen you were on. Inactive labels
          * move up to full `text-fg` too, since the row was uniformly dim. */}
        <nav className="inline-flex items-center gap-0.5 ml-2 rounded-md bg-panel-2 p-0.5">
          {NAV.map((n) => (
            <a key={n.label} href={href(n.route)}
              aria-current={active(n.route) ? 'page' : undefined}
              className={`px-2.5 py-1 rounded-[5px] text-[12px] no-underline hover:no-underline transition-colors ${
                active(n.route)
                  ? 'bg-accent text-panel font-medium'
                  : 'text-fg hover:text-accent'
              }`}>
              {n.label}
              {n.phase && <span className="ml-1 text-[9px] uppercase tracking-wider text-fg-faint">{n.phase}</span>}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-[11px] text-fg-muted">
          {/* The screen name rides along, so a report never has to answer
            * "where were you when this happened". */}
          <FeedbackButton screen={screenName(route)} />
          <ConnDot state={live.conn} lastFrameAt={live.lastFrameAt} />
          <PlanChip plan={plan} onSave={savePlan} />
          <ThemeToggle />
          <VersionChip />
          <a href="#/settings" className="text-fg-muted hover:text-fg no-underline">status</a>
        </div>
      </header>
      <main className="flex-1 p-3 max-w-[1600px] w-full mx-auto">{children}</main>
      <SiteFooter />
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

/**
 * The one place that says whether this page is still receiving anything — a
 * quiet dashboard and a dead one look identical, because nothing moves in
 * either, and the Attention strip deliberately stays silent when all is well.
 *
 * The age of the last frame has to be recomputed on a timer, not only when a
 * frame arrives: on an idle machine no frame arrives *by definition*, so a
 * label rendered once froze at "live · now" and kept saying it for hours.
 * That is the exact reading someone glancing from across the room relies on,
 * and it was the one case where it was wrong.
 */
function ConnDot({ state, lastFrameAt }: { state: 'connecting' | 'open' | 'closed'; lastFrameAt: number }) {
  const now = useNow(1000)
  const cls = state === 'open' ? 'bg-ok' : state === 'connecting' ? 'bg-warn' : 'bg-danger'
  const label = state === 'open' ? `live · ${lastFrameAt ? fmtAgo(lastFrameAt, now) : 'connected'}` : state === 'connecting' ? 'connecting…' : 'disconnected — reconnecting'
  return (
    <span className="inline-flex items-center gap-1.5" title={state === 'open' ? 'Connected to the daemon. The time is when it last sent anything — on an idle machine that keeps counting up, which is normal.' : 'WebSocket /v1/live'}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`} />
      <span className="num">{label}</span>
    </span>
  )
}

/**
 * The running version, always visible — the question "which build am I on?"
 * came up often enough that burying it on the status page was wrong. When a
 * newer release exists (and only if the user turned release checks on) it says
 * so here too, linking to the full notice rather than repeating it.
 */
function VersionChip() {
  const st = useApi(() => api.status(), [], { live: false, intervalMs: 60000 })
  const upd = useApi(() => api.update().catch(() => undefined), [], { live: false, intervalMs: 60000 })
  const version = st.data?.version
  if (!version) return null
  // A source build reports a `git describe` string or "dev"; showing that
  // verbatim in the header is noise, and it is never "out of date" anyway.
  const release = /^v?\d+\.\d+\.\d+$/.test(version)
  const newer = release && upd.data?.update_available ? upd.data.latest : undefined
  return newer ? (
    <a
      href="#/"
      className="mono text-[11px] text-accent hover:text-accent-strong no-underline"
      title={`${newer} is available — you are on ${version}`}
    >
      {version} → {newer}
    </a>
  ) : (
    <span className="mono text-[11px] text-fg-faint" title={release ? 'the running release' : 'a local build, not a published release'}>{release ? version : 'dev build'}</span>
  )
}
