/**
 * Work — every piece of work on the machine on its way to a release
 * (.ai/04-ui.md § Work; owner, 2026-10-15, translated: "exactly this I want
 * to see on the project-manager page", of a status report listing RELEASE,
 * IN WORK and NEXT with a bar per item).
 *
 * By default a list grouped Next release (merged and waiting, and ready
 * pull requests) / In review / In work / Planned / Released (recent, folded);
 * a toggle shows the same cards as Kanban columns. One row per piece of work
 * — a repository and branch at its furthest stage, its live sessions
 * attached; a session with no pull request is its own row (lib/work.ts).
 * Rows that need the person come first, then the working ones; sessions idle
 * at their prompt for over 30 minutes fold into "N idle".
 *
 * Reads `GET /v1/work` on live frames, at most once a second, and each
 * repository's Pipeline answer for up to four (lib/useWork.ts); nothing while
 * hidden.
 */
import { useCallback, useContext, useMemo, useState } from 'react'
import { ScreenShown } from '@/lib/refresh'
import { useNow } from '@/lib/useNow'
import { fmtUSD } from '@/lib/format'
import type { SessionCIStats, Work } from '@/lib/api'
import { boardOf, buildWork, groupOf, GROUPS, headline, laneOf, LANES, RELEASED_SHOWN, STATS_REPOS, statsRepos, type WorkBoard } from '@/lib/work'
import { useWork, useWorkStats } from '@/lib/useWork'
import { WorkColumn, WorkLane } from '@/components/WorkLane'
import { NextRelease } from '@/components/NextRelease'
import { Empty, Skeleton } from '@/components/ui'

type View = 'list' | 'kanban'
const VIEW_KEY = 'caprock.work.view'

function readView(): View {
  try { return localStorage.getItem(VIEW_KEY) === 'kanban' ? 'kanban' : 'list' } catch { return 'list' }
}

export interface WorkScreenProps {
  /** The app brings a session's tab forward; absent, the session's page opens. */
  onOpenSession?: (id: string) => void
}

export function WorkScreen({ onOpenSession }: WorkScreenProps) {
  const shown = useContext(ScreenShown)
  const work = useWork()
  const stats = useWorkStats(work.data?.repos ?? NO_REPOS, shown)
  const now = useNow(15_000)
  if (!work.data) {
    return work.error ? <Empty title="Cannot reach the daemon">{work.error.message}</Empty>
      : <Skeleton rows={4} className="rounded-[var(--radius-panel)] border border-border bg-panel" />
  }
  return <WorkView work={work.data} stats={stats} now={now} passed={Math.max(0, now - work.fetchedAt)} onOpenSession={onOpenSession} />
}

const NO_REPOS: never[] = []

/** The page itself, from a board answer and the Pipeline answers read: what the tests and the preview mount. */
export function WorkView({ work, stats, now, passed, onOpenSession }: { work: Work; stats: ReadonlyMap<string, SessionCIStats | undefined>; now: number; passed: number; onOpenSession?: (id: string) => void }) {
  const [view, setViewState] = useState<View>(readView)
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v) } catch { /* this page only */ } }
  const [showIdle, setShowIdle] = useState(false)
  // The daemon's clock: its `now` plus the time since it answered.
  const serverNow = work.now ? work.now + passed : now
  const board: WorkBoard = useMemo(() => buildWork(work, stats, serverNow), [work, stats, serverNow])
  const flowOf = useCallback((root?: string) => (root ? boardOf(stats.get(root))?.flow : undefined), [stats])
  const showRepo = new Set(board.items.map((it) => it.repo?.root).filter(Boolean)).size > 1 || (work.repos ?? []).length > 1
  const unread = (work.repos ?? []).length - statsRepos(work.repos ?? []).length
  const common = { now: serverNow, passed, flowOf, onOpenSession, showRepo }

  const idleLine = board.idle.length > 0 ? (
    <div data-work-idle className="border-t border-border px-3 py-2 text-[12.5px] text-fg-muted">
      <button type="button" onClick={() => setShowIdle((v) => !v)} aria-expanded={showIdle} className="text-left hover:text-fg">
        {board.idle.length} idle — at their prompt for over 30 min {showIdle ? '▾' : '▸'}
      </button>
      {showIdle && <ul className="mt-1 grid gap-0.5">{board.idle.map((it) => <li key={it.key} className="truncate">{it.title}{it.repo ? ` · ${it.repo.name}` : ''}</li>)}</ul>}
    </div>
  ) : undefined

  const nothing = board.items.length === 0 && board.idle.length === 0
  return (
    <div data-work-screen className="grid min-w-0 gap-4">
      <header className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-[15px] font-semibold text-fg">Work</h1>
        <p data-work-headline className="num min-w-0 text-[13px] text-fg [overflow-wrap:anywhere]">
          {headline(board.counts).split(' · ').map((p, i, a) => (
            <span key={p} className={p.includes('need') && board.counts.needsYou > 0 ? 'font-medium text-warn' : ''}>{p}{i < a.length - 1 ? ' · ' : ''}</span>
          ))}
        </p>
        <p className="num min-w-0 text-[12.5px] text-fg-muted" title="At API list price, not a bill: what Caprock recorded the live sessions spending since midnight, and every session on this machine">
          {fmtUSD(work.totals.today_usd)} today on live work · {fmtUSD(work.totals.machine_today_usd)} on the machine
        </p>
        <span role="tablist" aria-label="View" className="ml-auto inline-flex items-center gap-0.5 rounded-md bg-panel-2 p-0.5">
          {(['list', 'kanban'] as View[]).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} data-work-view={v} onClick={() => setView(v)}
              className={`whitespace-nowrap rounded-[5px] px-2.5 py-1 text-[12px] transition-colors motion-reduce:transition-none ${view === v ? 'bg-accent font-medium text-panel' : 'text-fg hover:text-accent'}`}>
              {v === 'list' ? 'List' : 'Kanban'}
            </button>
          ))}
        </span>
      </header>

      {nothing ? (
        <Empty title="Nothing in work">
          Start an agent in a git repository and it shows here, with its branch’s pull request on its way to a release. Sessions you start in your own terminal show too.
        </Empty>
      ) : (
        <>
          <NextRelease repos={work.repos ?? []} stats={stats} items={board.items} now={serverNow} />
          {view === 'list' ? (
            <div className="grid min-w-0 gap-3">
              {GROUPS.map((g, i) => (
                <WorkLane key={g.key} id={`list-${g.key}`} label={g.label} note={g.note} items={groupOf(board.items, g.key)} {...common}
                  hint={i === 0} folded={g.key === 'released'} limit={g.key === 'released' ? RELEASED_SHOWN : undefined}
                  footer={g.key === 'work' ? idleLine : undefined} />
              ))}
            </div>
          ) : (
            <div data-work-kanban className="@container/kanban min-w-0">
              <div className="grid min-w-0 grid-cols-1 gap-2 @[900px]/kanban:grid-cols-5">
                {LANES.map((l) => (
                  <WorkColumn key={l.key} id={l.key} label={l.label} note={l.note} items={laneOf(board.items, l.key)} {...common}
                    limit={l.key === 'released' ? RELEASED_SHOWN : undefined} footer={l.key === 'work' ? idleLine : undefined} />
                ))}
              </div>
            </div>
          )}
          {unread > 0 && (
            <p className="text-[12px] text-fg-muted">
              Pull requests are read for the {STATS_REPOS} repositories with agents running first; {unread} more show their agents and the pull requests recorded on them.
            </p>
          )}
          {work.hive === 'off' && (
            <p className="text-[12px] text-fg-muted">Tasks are off: the hive is not running, so planned work is only the messages queued for an agent.</p>
          )}
        </>
      )}
    </div>
  )
}
