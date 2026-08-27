import { useState } from 'react'
import type { ReactNode } from 'react'
import { useLive } from '@/lib/live'
import { href, type Route } from '@/lib/router'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { useTheme } from '@/lib/theme'
import { api, type UpdateStatus } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { PlanChip, usePlan } from '@/components/PlanPicker'
import { FeedbackButton } from '@/components/Feedback'
import { ShareButton } from '@/components/Share'
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
          {/* Beside feedback rather than buried in a panel on one screen: a
            * user asked where the button to share was, having been looking at
            * a control labelled "share these numbers" in 11px grey inside the
            * all-time panel. Available from every screen, at any time. */}
          <ShareButton />
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
 * The running version — and, in one click, how to move off it.
 *
 * This used to be a label: the version, and when a newer one existed, an
 * arrow to it. That answered "am I current?" and then stopped, which is the
 * half of the question nobody needs help with. The owner, on a machine with
 * a stale build, put it plainly: there is no clear update button that either
 * shows how to do it or does it.
 *
 * Doing it is not ours to do. Caprock is installed by Homebrew, `go install`
 * or a downloaded binary, and a daemon that overwrites its own executable —
 * unprompted, as root on some of those paths — is a far worse thing to own
 * than a stale version. So this shows the exact command for how *this* copy
 * was installed (the daemon already works that out) and copies it in one
 * click. One paste, and the shell does something the user can see.
 */
function VersionChip() {
  const st = useApi(() => api.status(), [], { live: false, intervalMs: 60000 })
  const upd = useApi(() => api.update().catch(() => undefined), [], { live: false, intervalMs: 60000 })
  const [open, setOpen] = useState(false)
  const version = st.data?.version
  if (!version) return null
  // A source build reports a `git describe` string or "dev"; showing that
  // verbatim in the header is noise, and it is never "out of date" anyway.
  const release = /^v?\d+\.\d+\.\d+$/.test(version)
  const newer = release && upd.data?.update_available ? upd.data.latest : undefined
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={
          newer
            ? 'mono text-[11px] text-accent hover:text-accent-strong'
            : 'mono text-[11px] text-fg-faint hover:text-fg'
        }
        title={newer ? `${newer} is available — you are on ${version}` : 'version and updates'}
      >
        {newer ? `${version} → ${newer}` : release ? version : 'dev build'}
      </button>
      {open && <UpdateDialog onClose={() => setOpen(false)} />}
    </>
  )
}

/** Version, what is published, and the one command that closes the gap. */
function UpdateDialog({ onClose }: { onClose: () => void }) {
  const st = useApi(() => api.status(), [], { live: false, intervalMs: 0 })
  const upd = useApi(() => api.update().catch(() => undefined), [], { live: false, intervalMs: 0 })
  const [checking, setChecking] = useState(false)
  const [fresh, setFresh] = useState<UpdateStatus | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const u = fresh ?? upd.data
  const version = st.data?.version ?? ''
  const release = /^v?\d+\.\d+\.\d+$/.test(version)
  // The daemon fills this in from the path it is running from, so it is right
  // for Homebrew, `go install` and a downloaded binary alike. It only arrives
  // with an available update, so fall back to the release page when it is
  // absent — better a page to click than a blank space.
  const cmd = u?.command

  const check = async () => {
    setChecking(true)
    try {
      setFresh(await api.checkUpdate())
    } catch {
      // A failed check is never fatal; the dialog keeps showing what it knew.
    } finally {
      setChecking(false)
    }
  }

  const copy = () => {
    if (!cmd) return
    void navigator.clipboard.writeText(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/50 flex items-start justify-center pt-[14vh] px-4" onClick={onClose}>
      <div
        className="w-full max-w-[460px] border border-border-strong bg-panel rounded-[var(--radius-panel)] shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Version and updates"
      >
        <div className="px-4 pt-3 pb-2 border-b border-border flex items-center">
          <span className="text-[15px] font-medium">Version</span>
          <button onClick={onClose} className="ml-auto text-[16px] leading-none text-fg-faint hover:text-fg">×</button>
        </div>
        <div className="p-4 grid gap-3">
          <div className="flex items-baseline gap-2 text-[13px]">
            <span className="text-fg-muted">running</span>
            <span className="mono text-fg">{release ? version : `${version} (local build)`}</span>
          </div>

          {u?.update_available ? (
            <>
              <div className="text-[15px] text-fg">
                <span className="mono text-accent">{u.latest}</span> is out.
              </div>
              {cmd && (
                <div className="grid gap-1.5">
                  <div className="text-[12px] text-fg-muted">Run this to update:</div>
                  <div className="flex items-center gap-2">
                    <code className="mono flex-1 truncate rounded-sm border border-border bg-bg px-2 py-1.5 text-[13px] text-fg">{cmd}</code>
                    <button
                      onClick={copy}
                      className="rounded-md border border-accent/45 bg-accent/[0.08] px-3 py-1.5 text-[13px] text-accent hover:bg-accent/[0.16]"
                    >
                      {copied ? 'copied' : 'copy'}
                    </button>
                  </div>
                  {/* Caprock will not overwrite its own binary. Saying why,
                    * once, beats a user wondering where the button is. */}
                  <div className="text-[11px] text-fg-faint">
                    Caprock does not update itself — it would have to overwrite its own binary while running.
                  </div>
                </div>
              )}
              {/* A downloaded binary or a container: no package manager owns
                * this copy, so `InstallCommand` returns "" rather than name a
                * command that might do the wrong thing. Without this branch
                * the dialog announced a new version and then said nothing
                * about how to get it — the exact gap it exists to close. */}
              {!cmd && (
                <div className="text-[13px] text-fg-muted">
                  This copy was not installed by a package manager, so there is no one command to give you.
                  Download the new binary from the release page below and replace this one.
                </div>
              )}
            </>
          ) : u?.enabled === false ? (
            <div className="text-[13px] text-fg-muted">
              Release checks are off, so this copy never asks GitHub what the latest version is. Turn them on in{' '}
              <a href="#/status" onClick={onClose} className="text-accent no-underline hover:text-accent-strong">status</a>.
            </div>
          ) : (
            <div className="text-[13px] text-fg-muted">
              {u?.latest ? `Up to date — ${u.latest} is the latest release.` : 'No newer release found.'}
            </div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={check}
              disabled={checking}
              className="rounded-md border border-border px-3 py-1.5 text-[13px] text-fg-muted hover:text-fg disabled:opacity-50"
            >
              {checking ? 'checking…' : 'check now'}
            </button>
            <a
              href={u?.url ?? 'https://github.com/dspv/caprock/releases/latest'}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[12px] text-fg-faint no-underline hover:text-accent"
            >
              release notes →
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
