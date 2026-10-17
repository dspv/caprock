/**
 * A multi-repo project's repositories, on its page (ADR-055): each member's
 * branch, changed files, open pull requests on GitHub, and its share of
 * today's spend and of the sessions; the project's own line sums them.
 *
 * Git state comes with the project (the daemon reads each member's git once
 * on add, after an agent edits there, and when this panel opens — never on a
 * timer); open pull requests are asked once as the panel opens and kept 60 s
 * by the daemon. *Edit* opens the project editor; *Add…* the Add a
 * repository sheet (ADR-077). The home repository — the root, where agents
 * start, in a project of repositories picked one by one — says so.
 */
import { useEffect, useState } from 'react'
import { fmtUSD } from '@/lib/format'
import { projectsApi, type Project, type RepoInfo } from '@/lib/projects'
import { isHomeRepo, reposLabel } from '@/lib/multirepo'
import { ProjectEditor } from './ProjectEditor'
import { AddRepoSheet } from './AddRepoSheet'

export function ProjectRepos({ project, projects }: { project: Project; projects: readonly Project[] }) {
  const repos = project.repos ?? []
  // Open pull requests per member path, from GET …/repos.
  const [prs, setPrs] = useState<Map<string, Pick<RepoInfo, 'open_prs' | 'prs_error'>>>(() => new Map())
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    let alive = true
    projectsApi.repos(project.id).then((list) => {
      if (alive) setPrs(new Map(list.map((r) => [r.path, { open_prs: r.open_prs, prs_error: r.prs_error }])))
    }, () => { /* the list itself still shows */ })
    return () => { alive = false }
  }, [project.id, repos.length])
  const total = repos.reduce((s, r) => s + r.cost_today, 0)
  const outside = Math.max(0, (project.cost_today ?? 0) - total)
  return (
    <section aria-label="Repositories" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.06em] text-fg-muted">{reposLabel(repos.length)}</h2>
        <span className="text-[12px] tabular-nums text-fg-faint">today {fmtUSD(project.cost_today ?? 0)}</span>
        <button type="button" onClick={() => setAdding(true)} className="ml-auto rounded-[6px] px-2 py-0.5 text-[12.5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
          Add…
        </button>
        <button type="button" onClick={() => setEditing(true)} className="rounded-[6px] px-2 py-0.5 text-[12.5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
          Edit
        </button>
      </div>
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-px overflow-hidden rounded-[8px] border border-[var(--app-hairline)] bg-[var(--app-hairline)]">
        {repos.map((r) => {
          const pr = prs.get(r.path)
          const share = (project.cost_today ?? 0) > 0 ? Math.round((r.cost_today / (project.cost_today ?? 1)) * 100) : 0
          return (
            <li key={r.path} data-repo={r.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 bg-panel px-3 py-2">
              <span className="mono min-w-0 truncate text-[13px] text-fg" title={r.path}>
                {r.name}
                {isHomeRepo(project, r.path) && <span className="ml-2 font-sans text-[12px] text-fg-muted" title="The home repository: agents start here and reach the others">home</span>}
                {!r.exists && <span className="ml-2 font-sans text-[12px] text-danger">folder missing</span>}
              </span>
              <span className="text-right text-[12.5px] tabular-nums text-fg">
                {fmtUSD(r.cost_today)}
                {share > 0 && <span className="ml-1 text-fg-faint">{share}%</span>}
              </span>
              <span className="min-w-0 truncate text-[12px] text-fg-muted">
                <span className="mono">{r.branch ?? (r.gitError ? 'git: ' + r.gitError : '…')}</span>
                {!!r.changed && <span className="ml-2">±{r.changed}</span>}
                {!!r.ahead && <span className="ml-2">↑{r.ahead}</span>}
                {!!r.behind && <span className="ml-1">↓{r.behind}</span>}
                {pr?.open_prs !== undefined && <span className="ml-2">{pr.open_prs === 0 ? 'no open PRs' : `${pr.open_prs}${pr.open_prs >= 100 ? '+' : ''} open PR${pr.open_prs === 1 ? '' : 's'}`}</span>}
              </span>
              <span className="text-right text-[12px] tabular-nums text-fg-faint">
                {r.live > 0 ? `${r.live} live` : r.total > 0 ? `${r.total} session${r.total === 1 ? '' : 's'}` : ''}
              </span>
            </li>
          )
        })}
      </ul>
      {outside > 0.005 && (
        <p className="text-[12px] text-fg-faint">{fmtUSD(outside)} today in the folder outside these repositories.</p>
      )}
      {editing && <ProjectEditor project={project} projects={projects} onClose={() => setEditing(false)} />}
      {adding && <AddRepoSheet project={project} onClose={() => setAdding(false)} />}
    </section>
  )
}
