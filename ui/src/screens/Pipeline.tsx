/**
 * The Pipeline as a page of the dashboard, at #/pipeline (.ai/04-ui.md
 * § Pipeline; owner, 2026-10-15, translated: "I'd build this into the
 * Dashboard as a separate page, opened there — Pipeline, simply in the
 * Dashboard's style … Pipeline is part of the Dashboard, just a separate
 * page"). It sits in the dashboard's nav beside Cost and Week. In the app it
 * renders in a pinned tab of its own beside the Dashboard tab (owner, later
 * that day, translated: "as a separate page with its own tab — among the
 * system tabs, next to the dashboard"; AppShell), where the nav, Home's card
 * and ⌘P lead; in a browser, inside the dashboard.
 * `pr` (#/pipeline?repo=…&pr=N, a Work row's title) opens that pull
 * request's detail beside the list.
 *
 * It shows one repository, picked in its head: the one the address names
 * (`repo`), else that of the agent it was opened from (`of`), else the one
 * shown last, else one with an agent running (lib/pipeline). What it draws is
 * components/PipelineView.tsx.
 */
import { useContext, useEffect, useMemo } from 'react'
import { api, type SessionSummary } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { navigate } from '@/lib/router'
import { ScreenShown } from '@/lib/refresh'
import { PipelineHostContext } from '@/lib/pipelineHost'
import { pickPipeline, pipelineRepos, rememberRepo, type PipelineRepo } from '@/lib/pipeline'
import { useRepoRemotes } from '@/lib/useRepoRemotes'
import { PipelineView } from '@/components/PipelineView'
import { Empty, Skeleton } from '@/components/ui'

/** How many repositories show as pills; the rest are in a list beside them. */
const PILLS = 5

const none = (): Promise<SessionSummary[]> => Promise.resolve([])

export function PipelineScreen({ repo, of, pr }: { repo?: string; of?: string; pr?: number }) {
  const host = useContext(PipelineHostContext)
  const shown = useContext(ScreenShown)
  // The app hands its own list; a browser tab reads it, rarely: a new
  // repository is a new session, not something to watch for by the second.
  const own = useApi(host.sessions ? none : () => api.sessions(), [!!host.sessions], { live: false, intervalMs: 60_000 })
  const sessions = host.sessions ?? own.data
  // Only git repositories with a GitHub remote, clones of one folded (lib/pipeline).
  const remotes = useRepoRemotes(sessions)
  const repos = useMemo(() => pipelineRepos(sessions ?? [], remotes), [sessions, remotes])
  const pick = useMemo(() => pickPipeline(sessions ?? [], { repo, of }, undefined, remotes), [sessions, repo, of, remotes])
  // What is shown is what Home's card and the next visit show.
  useEffect(() => { if (pick.repo && shown) rememberRepo(pick.repo.root) }, [pick.repo, shown])

  const choose = (root: string) => {
    rememberRepo(root)
    navigate({ name: 'pipeline', repo: root })
  }
  const picker = repos.length > 0 ? <RepoPicker repos={repos} current={pick.repo?.root} onPick={choose} /> : null

  if (!sessions) {
    return own.error ? <Empty title="Cannot reach the daemon">{own.error.message}</Empty>
      : <Skeleton rows={4} className="rounded-[var(--radius-panel)] border border-border bg-panel" />
  }
  if (repos.length === 0) {
    return (
      <Empty title="No repository yet">
        The Pipeline shows a repository’s pull requests on their way to a release. Start an agent in a git repository on GitHub and it shows up here; a folder that is not one is not listed.
      </Empty>
    )
  }
  if (!pick.repo || !pick.session) {
    return (
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">{picker}</div>
        <p className="text-[13px] text-fg-muted">{of && !repo
          ? 'That agent’s folder is not a git repository on GitHub, so it has no pipeline. Pick a repository above.'
          : 'No agent session was recorded in that repository. Pick one above.'}</p>
      </div>
    )
  }
  const s = pick.session
  return (
    <div data-pipeline-screen>
      <PipelineView
        key={pick.repo.root}
        sessionId={s.session_id}
        session={s}
        visible={shown}
        onBack={host.onBack}
        onToast={host.onToast}
        worktrees={host.worktreesOf?.(s.session_id)}
        onStartAgent={host.onStartAgent ? (req, title) => host.onStartAgent!(req, title, s.session_id) : undefined}
        picker={picker}
        pr={pr}
      />
    </div>
  )
}

/** A picker entry's tooltip: owner/name on GitHub, then every folder folded into it. */
function pickerTitle(r: PipelineRepo): string {
  return [r.remote, ...r.roots].filter(Boolean).join('\n')
}

/** The repositories as the dashboard's filter pills; the rest in a list. A dot marks one with an agent running. */
function RepoPicker({ repos, current, onPick }: { repos: PipelineRepo[]; current?: string; onPick: (root: string) => void }) {
  const pills = repos.slice(0, PILLS)
  // The one shown stays a pill even when it is not among the first.
  const cur = repos.find((r) => r.root === current)
  if (cur && !pills.includes(cur)) pills[pills.length - 1] = cur
  const rest = repos.filter((r) => !pills.includes(r))
  return (
    <div data-pipeline-repos className="flex min-w-0 flex-wrap items-center gap-2">
      <h1 className="text-[15px] font-semibold text-fg">Pipeline</h1>
      <span role="tablist" aria-label="Repository" className="inline-flex min-w-0 flex-wrap items-center gap-0.5 rounded-md bg-panel-2 p-0.5">
        {pills.map((r) => {
          const on = r.root === current
          return (
            <button key={r.root} type="button" role="tab" aria-selected={on} data-pipeline-repo={r.name} onClick={() => onPick(r.root)} title={pickerTitle(r)}
              className={`inline-flex max-w-[220px] items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2.5 py-1 text-[12px] transition-colors motion-reduce:transition-none ${on ? 'bg-accent font-medium text-panel' : 'text-fg hover:text-accent'}`}>
              {r.live > 0 && <span aria-label={`${r.live} agent${r.live === 1 ? '' : 's'} running`} className={`inline-block h-[6px] w-[6px] shrink-0 rounded-full ${on ? 'bg-panel' : 'bg-ok'}`} />}
              <span className="truncate">{r.name}</span>
            </button>
          )
        })}
      </span>
      {rest.length > 0 && (
        <select aria-label="Another repository" value="" onChange={(e) => { if (e.target.value) onPick(e.target.value) }}
          className="h-[28px] max-w-[200px] rounded-md border border-border bg-panel-2 px-2 text-[12px] text-fg">
          <option value="">{rest.length} more…</option>
          {rest.map((r) => <option key={r.root} value={r.root} title={pickerTitle(r)}>{r.name}</option>)}
        </select>
      )}
    </div>
  )
}
