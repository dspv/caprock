/**
 * Fix CI and Re-run on a failing pull request, from the phone (owner,
 * 2026-11-28, translated: "on the phone there is simply no button to send a
 * red CI to be fixed"). The cockpit's own actions (lib/usePRForce): Fix CI
 * queues Investigate's message — the failed job with its log — to the agent
 * Caprock started on the branch or the session in front, else starts a new
 * agent in a worktree at the PR's head; Re-run asks GitHub to run the failed
 * jobs again. Each asks once, inline (*Ask to fix #1042 CI? Confirm Cancel*,
 * the whole sentence on a long press's title), then says what it is doing.
 * Every target is 44px; the row wraps, never scrolls sideways.
 *
 * Two places draw it (.ai/04-ui.md § The phone home, *Fix CI from the
 * phone*): a red pull request row of the phone home's Releases, and the
 * session sheet's *Pull requests* (`PhoneSessionPRs`). What it reads — a
 * phone pays for every byte, so no timer: the PR's runs (`GET
 * /v1/sessions/{id}/ci?pr=`) once when drawn, on a pull, and once after an
 * action went through; the failed job's log only when Fix CI is confirmed.
 * All of it is on a paired device's allowlist, the re-run and the fix on a
 * controller's (lanauth.go); a phone that may only watch sees the buttons
 * off with the reason under them.
 */
import { useEffect, useRef, useState } from 'react'
import { api, type SessionCI, type SessionPRLive, type SessionPRs, type SessionSummary, type SpawnRequest } from '@/lib/api'
import { FORCE_TITLE, queueWhy, usePRForce } from '@/lib/usePRForce'
import { useCanControl } from '@/lib/useCanControl'
import { useNow } from '@/lib/useNow'
import { extTitle } from '@/lib/externalLinks'

/** The actions a PR's checks call for: a real failure, Fix CI and Re-run; a job GitHub gave no machine, Re-run. */
export function phoneCIKinds(p: SessionPRLive | undefined): ('ci' | 'rerun')[] {
  const live = p?.live
  if (!live || live.state !== 'open') return []
  return live.checks.state === 'fail' ? ['ci', 'rerun'] : live.checks.state === 'no_runner' ? ['rerun'] : []
}

const LABEL = { ci: 'Fix CI', rerun: 'Re-run' } as const
/** How soon the PR is read again after an action went through: GitHub shows a re-run queued within seconds. */
const AGAIN_MS = 10_000

export interface PhonePRFixProps {
  /** The session the routes go through (its own PR, or one of its repository's). */
  sessionId: string
  /** Who a fix is typed into when `why` is '': an agent Caprock started. */
  s: SessionSummary
  /** Why nothing can be queued to `s` ('' when it can): a fix then starts a new agent. */
  why: string
  number: number
  /** What is known of it already (the session's PR list), drawn until its runs are read. */
  initial?: SessionPRLive
  /** A pull to refresh: read again. */
  pull?: number
}

export function PhonePRFix({ sessionId, s, why, number, initial, pull = 0 }: PhonePRFixProps) {
  const canControl = useCanControl()
  const now = useNow(30_000)
  const [ci, setCI] = useState<SessionCI>()
  const [again, setAgain] = useState(0)
  const [said, setSaid] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    let alive = true
    api.sessionCI(sessionId, number).then((d) => { if (alive) setCI(d) }, () => { /* the row stays as it was read */ })
    return () => { alive = false }
  }, [sessionId, number, pull, again])
  const read = ci?.pr?.number === number && ci.pr.live ? ci.pr : undefined
  const p: SessionPRLive | undefined = read
    ? { session_id: sessionId, number, url: read.url, title: read.title, last_at: initial?.last_at ?? 0, live: read.live }
    : initial?.live ? initial : undefined
  const kit = usePRForce({
    sessionId, s, canControl, connected: ci?.connected ?? (initial ? true : undefined), why,
    onToast: setSaid,
    // The phone starts it as New agent does: POST /v1/agents, under home.
    onStartAgent: async (req: SpawnRequest) => { await api.spawn(req) },
    runsOf: (x) => (ci?.pr?.number === x.number ? ci.ci?.runs : undefined),
    onDone: () => { clearTimeout(timer.current); timer.current = setTimeout(() => setAgain((n) => n + 1), AGAIN_MS) },
  })
  if (!p) return null
  const g = kit.standing(p, [], now)
  const kinds = phoneCIKinds(p)
  if (!g && kinds.length === 0) return said ? <p role="status" className="px-3 pb-2 text-[13px] text-fg-muted">{said}</p> : null
  const c = kit.confirm?.pr === number ? kit.confirm : undefined
  const refused = kinds.map((k) => kit.forceWhy(p, k))
  const allRefused = refused.length > 0 && refused.every(Boolean)
  return (
    <div data-phone-pr-fix={number} className="flex min-w-0 flex-wrap items-center gap-2">
      {g ? (
        <span data-phone-pr-fix-progress className="flex min-h-11 items-center text-[14px] text-accent">{g.text}</span>
      ) : c ? (
        <div data-phone-pr-fix-confirm className="flex w-full min-w-0 items-center gap-2">
          <span data-phone-pr-fix-question title={kit.confirmText(p, c.kind)} className="min-w-0 flex-1 truncate text-[14px] text-fg">{kit.confirmShort(p, c.kind)}</span>
          <button type="button" data-phone-pr-fix-yes onClick={() => void kit.force(p, c.kind)}
            className="min-h-11 shrink-0 rounded-[8px] border border-accent/60 bg-accent/10 px-3.5 text-[14px] font-medium text-accent active:bg-accent/20">Confirm</button>
          <button type="button" data-phone-pr-fix-no onClick={() => kit.setConfirm(undefined)}
            className="min-h-11 shrink-0 rounded-[8px] px-3 text-[14px] text-fg-muted active:bg-panel-2">Cancel</button>
        </div>
      ) : (
        kinds.map((k, i) => (
          <button key={k} type="button" data-phone-pr-fix-action={k} disabled={!!refused[i] || kit.forcing === number}
            onClick={() => { setSaid(''); kit.setConfirm({ pr: number, kind: k }) }} title={refused[i] || FORCE_TITLE[k]}
            className={`min-h-11 shrink-0 rounded-[8px] border px-3.5 text-[14px] font-medium disabled:border-border disabled:font-normal disabled:text-fg-faint ${k === 'ci' ? 'border-accent/60 text-accent active:bg-accent/10' : 'border-border-strong text-fg active:bg-panel-2'}`}>
            {LABEL[k]}
          </button>
        ))
      )}
      {/* Never silently unavailable (owner, 2026-10-16): the reason, in words. */}
      {!g && !c && allRefused && <p data-phone-pr-fix-why className="basis-full text-[12.5px] leading-snug text-fg-faint">{refused[0]}</p>}
      {said && <p role="status" data-phone-pr-fix-said className="basis-full text-[13px] text-fg-muted [overflow-wrap:anywhere]">{said}</p>}
    </div>
  )
}

/**
 * The session sheet's *Pull requests*: each open pull request of the session
 * whose checks failed, its number and title, and Fix CI and Re-run under it.
 * Nothing when none fails. One read of the session's pull requests (`GET
 * /v1/sessions/{id}/prs`) when the sheet opens.
 */
export function PhoneSessionPRs({ sessionId, s }: { sessionId: string; s: SessionSummary }) {
  const canControl = useCanControl()
  const [prs, setPRs] = useState<SessionPRs>()
  useEffect(() => {
    let alive = true
    api.sessionPRs(sessionId).then((d) => { if (alive) setPRs(d) }, () => { /* nothing drawn */ })
    return () => { alive = false }
  }, [sessionId])
  const failing = (prs?.prs ?? []).filter((p) => phoneCIKinds(p).length > 0)
  if (failing.length === 0) return null
  const why = queueWhy(s, canControl)
  return (
    <section aria-label="Pull requests" data-phone-session-prs className="grid min-w-0 gap-2 border-t border-border pt-2.5">
      {failing.map((p) => (
        <div key={p.number} data-phone-session-pr={p.number} className="grid min-w-0 gap-1">
          <a href={p.live?.url || p.url} target="_blank" rel="noopener noreferrer" title={extTitle(`#${p.number} on GitHub`)} className="flex min-h-11 min-w-0 items-center gap-1.5 text-[14px] text-fg no-underline">
            <span className="num shrink-0 text-fg-muted">#{p.number}</span>
            <span className="min-w-0 truncate">{p.live?.title || p.title}</span>
            <span className="ml-auto shrink-0 text-[13px] font-medium text-danger">{p.live?.checks.state === 'no_runner' ? 'no runner' : 'CI failed'}</span>
          </a>
          <PhonePRFix sessionId={sessionId} s={s} why={why} number={p.number} initial={p} />
        </div>
      ))}
    </section>
  )
}
