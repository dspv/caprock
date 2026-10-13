/**
 * The cockpit's CI block (owner, 2026-10-13, translated: "I'd like to move
 * some CI/CD indicators into the right part — try making the indicator switch
 * between views right away, we'll see what sticks"): the session's pull
 * requests and their checks, in one of three views kept per viewer —
 * each PR's checks in one short group (the default, as the deck's rows
 * say them: "✗ 1 failed ✓ 11", every check on hover), one ring with "10/11 · 4m" and the time
 * against the median, or the open PR's jobs by runner OS. A click opens the
 * PRs & CI tab.
 *
 * It asks nothing: it draws what the session deck was last told
 * (lib/deckCache, `prs:<session>` and `ci:<session>:<pr>`) and redraws when
 * the deck is told something new. With the deck closed it shows the last
 * answer and how old it is; with nothing kept it is not drawn.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SessionCI, SessionPRs } from '@/lib/api'
import type { PRCheck } from '@/lib/github'
import { orderPRs, prChecks, prDotState, prVerdict, readCockpitCIView, runVsMedian, saveCockpitCIView, fmtRun, ciTone, type CITone, type CockpitCIView, type PRWordTone } from '@/lib/ci'
import { freshText, onDeckAnswer, readDeck } from '@/lib/deckCache'
import { GRID_OS_LABEL, jobGrid } from '@/lib/prstats'
import { CheckSummary } from './CheckSummary'
import { SectionLabel } from './Cockpit'

/** The most pull requests listed in the circles view. */
const SHOWN = 3

const WORD: Record<PRWordTone, string> = {
  ok: 'text-ok', fail: 'text-danger', pending: 'text-warn', muted: 'text-fg-muted', faint: 'text-fg-faint',
}

const VIEWS: { v: CockpitCIView; label: string; title: string }[] = [
  { v: 'dots', label: 'PRs', title: 'Each pull request’s checks: how many failed, run and passed; hover one for every check' },
  { v: 'ring', label: 'Ring', title: 'One ring: checks done, the time, and against the median' },
  { v: 'grid', label: 'OS', title: 'The open pull request’s jobs by runner OS' },
]

/** The deck's last answer under key, redrawn when the deck is told a new one. */
function useDeckAnswer<T>(key: string): { d?: T; at?: number } {
  const snap = useSyncExternalStore(
    (cb) => onDeckAnswer((k) => { if (k === key) cb() }),
    () => readDeck<T>(key),
  )
  return { d: snap?.d, at: snap?.at }
}

/** Where a PR's checks stand: how many of each, and how long since the first started. */
export function checkSummary(items: PRCheck[], now: number): { total: number; pass: number; fail: number; running: number; queued: number; ms?: number } {
  let pass = 0, fail = 0, running = 0, queued = 0
  let start = Infinity, end = 0
  for (const c of items) {
    if (c.state === 'pass') pass++
    else if (c.state === 'fail') fail++
    else if (c.state === 'skipped') { /* counted in the total only */ }
    else if (c.status === 'in_progress') running++
    else queued++
    if (c.started_at) start = Math.min(start, c.started_at)
    end = Math.max(end, c.completed_at || 0)
  }
  const done = running === 0 && queued === 0
  const ms = start === Infinity ? undefined : Math.max(0, (done ? end : now) - start)
  return { total: items.length, pass, fail, running, queued, ms: ms || undefined }
}

export function CockpitCI({ sessionId, onOpen }: { sessionId: string; onOpen?: () => void }) {
  const [view, setViewState] = useState<CockpitCIView>(readCockpitCIView)
  const setView = (v: CockpitCIView) => { setViewState(v); saveCockpitCIView(v) }
  const prs = useDeckAnswer<SessionPRs>(`prs:${sessionId}`)
  const rows = orderPRs(prs.d?.prs ?? []).filter((p) => !!p.live)
  const lead = rows[0]
  const ci = useDeckAnswer<SessionCI>(lead ? `ci:${sessionId}:${lead.number}` : '')
  const running = rows.some((p) => p.live?.checks.state === 'pending')
  // A clock only while a check runs and the window is shown: the elapsed time moves.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!running) return
    const t = window.setInterval(() => { if (!document.hidden) setNow(Date.now()) }, 1000)
    return () => window.clearInterval(t)
  }, [running, prs.at, ci.at])
  if (!prs.d || !prs.d.connected || rows.length === 0) return null

  const body = view === 'ring' ? <Ring p={lead!} ci={ci.d} now={now} /> : view === 'grid' ? <Grid ci={ci.d} lead={lead!.number} /> : (
    <ul className="grid gap-1">
      {rows.slice(0, SHOWN).map((p) => {
        const sum = prChecks(p, now)
        const v = prVerdict(p, now)
        const title = p.live?.title || p.title || ''
        return (
          <li key={p.url} data-cockpit-ci-pr={p.number} className="flex min-w-0 items-center gap-1.5 text-[12px]">
            <span aria-hidden className="pr-dot" data-state={prDotState(p)} />
            <span className="num shrink-0 text-fg-muted">#{p.number}</span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-faint" title={title}>{title}</span>
            {sum
              ? <CheckSummary s={sum} label={`#${p.number}: its checks`} focusable={false} className="shrink-0" />
              : <span title={v.title ?? v.text} className={`shrink-0 truncate text-[11px] ${WORD[v.tone]}`}>{v.text}</span>}
          </li>
        )
      })}
      {rows.length > SHOWN && <li className="text-[11px] text-fg-faint">+{rows.length - SHOWN} more</li>}
    </ul>
  )

  return (
    <section aria-label="CI" data-cockpit-ci={view} className="grid gap-2">
      <SectionLabel right={(
        <span className="flex items-center gap-2">
          <span className="text-[10.5px] text-fg-faint" title="What the session deck last read; the cockpit asks nothing itself">{prs.at ? freshText(now - prs.at).replace('updated ', '') : ''}</span>
          <span role="tablist" aria-label="CI view" className="flex items-center gap-px rounded-[5px] border border-[var(--app-hairline)] p-px">
            {VIEWS.map((x) => (
              <button key={x.v} type="button" role="tab" aria-selected={view === x.v} data-cockpit-ci-view={x.v} title={x.title} onClick={() => setView(x.v)}
                className={`rounded-[4px] px-1.5 text-[10.5px] leading-[15px] ${view === x.v ? 'bg-[var(--app-row-hover)] text-fg' : 'text-fg-faint hover:text-fg-muted'}`}>{x.label}</button>
            ))}
          </span>
        </span>
      )}>CI</SectionLabel>
      <button type="button" data-cockpit-ci-open onClick={onOpen} disabled={!onOpen} title="Open the PRs & CI tab"
        className="-mx-1.5 rounded-[6px] px-1.5 py-1 text-left hover:bg-[var(--app-row-hover)] disabled:cursor-default disabled:hover:bg-transparent">
        {body}
      </button>
    </section>
  )
}

/** One ring for the lead PR: its checks done of all, its time, and its run against the median. */
function Ring({ p, ci, now }: { p: NonNullable<ReturnType<typeof orderPRs>[number]>; ci?: SessionCI; now: number }) {
  const s = checkSummary(p.live!.checks.items, now)
  const r = 15
  const c = 2 * Math.PI * r
  const arc = (n: number) => (s.total ? (n / s.total) * c : 0)
  const segs: { n: number; color: string }[] = [
    { n: s.pass, color: 'var(--color-ok)' }, { n: s.fail, color: 'var(--color-danger)' }, { n: s.running, color: 'var(--color-warn)' },
  ]
  let off = 0
  const run = ci?.pr?.number === p.number ? ci.ci?.runs?.[0] : undefined
  const vs = run ? runVsMedian(run, now) : undefined
  const done = s.pass + s.fail
  return (
    <span data-cockpit-ci-ring className="flex items-center gap-3">
      <svg width="38" height="38" viewBox="0 0 38 38" role="img" aria-label={`${done} of ${s.total} checks done`} className="shrink-0 -rotate-90">
        <circle cx="19" cy="19" r={r} fill="none" stroke="var(--app-hairline)" strokeWidth="4" />
        {segs.map((g, i) => {
          const len = arc(g.n)
          const el = len > 0 ? <circle key={i} cx="19" cy="19" r={r} fill="none" stroke={g.color} strokeWidth="4" strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-off} className={g.color.includes('warn') ? 'animate-pulse motion-reduce:animate-none' : ''} /> : null
          off += len
          return el
        })}
      </svg>
      <span className="grid min-w-0 gap-0.5">
        <span className="num text-[15px] font-semibold leading-none text-fg">{done}/{s.total}{s.ms ? <span className="text-[12px] font-normal text-fg-muted"> · {fmtRun(s.ms)}</span> : null}</span>
        <span className="truncate text-[11px] text-fg-muted">
          #{p.number}{s.fail ? <span className="text-danger"> · {s.fail} failed</span> : null}{s.running ? <span className="text-warn"> · {s.running} running</span> : null}
          {vs ? <span className={vs.tone === 'warn' ? 'text-warn' : 'text-fg-faint'}> · {vs.text}</span> : null}
        </span>
      </span>
    </span>
  )
}

const CELL: Record<CITone, string> = { pass: 'pass', fail: 'fail', running: 'running', queued: 'queued', skipped: 'skipped' }

/** The lead PR's jobs as a small job × OS matrix of circles, from its CI as the deck last read it. */
function Grid({ ci, lead }: { ci?: SessionCI; lead: number }) {
  const runs = ci?.pr?.number === lead ? ci.ci?.runs ?? [] : []
  if (runs.length === 0) return <span className="text-[11.5px] text-fg-faint">#{lead}’s jobs show once its row is opened in the deck.</span>
  const g = jobGrid(runs)
  return (
    <span data-cockpit-ci-grid className="grid gap-x-2 gap-y-1 text-[11px]" style={{ gridTemplateColumns: `minmax(0,1fr) repeat(${g.oses.length}, auto)` }}>
      <span />
      {g.oses.map((o) => <span key={o} className="text-center text-[10px] text-fg-faint">{GRID_OS_LABEL[o]}</span>)}
      {g.families.slice(0, 6).map((f) => (
        <span key={f} className="contents">
          <span className="truncate text-fg-muted" title={f}>{f}</span>
          {g.oses.map((o) => {
            const j = g.cell(f, o)
            return <span key={o} className="flex justify-center" title={j ? `${j.name}: ${ciTone(j)}` : undefined}>{j ? <span className="pipe-node" data-size="sm" data-tone={CELL[ciTone(j)]} /> : <span className="text-fg-faint">·</span>}</span>
          })}
        </span>
      ))}
    </span>
  )
}
