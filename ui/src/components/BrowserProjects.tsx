/** The browser's entry into the computer's projects, above the dashboard figures. */
import { useState } from 'react'
import { api, type SessionSummary } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { deriveProjects, disambiguate, matchLength, projectsApi, type Project } from '@/lib/projects'
import { href } from '@/lib/router'
import { sessionHealth } from '@/lib/sessionLabels'
import { shortId } from '@/lib/format'
import { isChat } from '@/lib/chats'
import { AgentGlyph } from './AgentMarks'

/** Include observed work too, without inventing a second project for a member repository. */
export function browserProjects(saved: Project[], sessions: SessionSummary[]): Project[] {
  const visible = saved.filter((p) => !p.archived_at)
  const observed = deriveProjects(sessions.filter((s) =>
    !saved.some((p) => matchLength({ ...s, cwd: s.cwd || '' }, p) >= 0)), [])
  return disambiguate([...visible, ...observed]).sort((a, b) =>
    Number(!!b.pinned) - Number(!!a.pinned) || (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name))
}

/** A session belongs to its closest project, as in the desktop sidebar. */
function belongs(s: SessionSummary, p: Project, projects: Project[]): boolean {
  const length = matchLength({ ...s, cwd: s.cwd || '' }, p)
  return length >= 0 && !projects.some((other) => other.id !== p.id && matchLength({ ...s, cwd: s.cwd || '' }, other) > length)
}

export function BrowserProjects() {
  const saved = useApi(() => projectsApi.list(), [], { live: false, intervalMs: 60_000 })
  // No recent-history cap: a quiet live session must still be reachable.
  const active = useApi(() => api.sessionsWithTotal(true, '', 0, 'exclude'), [], { intervalMs: 5000, liveMs: 1000 })
  const sessions = (active.data?.items ?? []).filter((s) => !isChat(s))
  const loading = (!saved.data && !saved.error) || (!active.data && !active.error)
  const projects = browserProjects(saved.data ?? [], sessions)
  const [open, setOpen] = useState<string | null>(null)
  return (
    <section aria-label="Projects" className="min-w-0">
      <h2 className="mb-2 text-[18px] font-semibold text-fg">Projects</h2>
      {(saved.error || active.error) && <p role="status" className="mb-2 text-[14px] text-warn">
        {saved.error ? 'Could not load projects.' : 'Could not refresh live sessions.'}{' '}
        <button type="button" className="min-h-11 text-accent underline" onClick={() => { saved.refresh(); active.refresh() }}>Try again</button>
      </p>}
      {projects.length === 0 ? <p className="rounded-[12px] border border-border bg-panel p-3 text-[15px] text-fg-muted">
        {loading ? 'Reading your projects…' : saved.error || active.error ? 'Your projects are unavailable.' : 'No projects yet. Add a project on your computer to see it here.'}
      </p> : <ul className="overflow-hidden rounded-[12px] border border-border bg-panel divide-y divide-border">
        {projects.map((p) => {
          const live = sessions.filter((s) => belongs(s, p, projects))
          const selected = open === p.id
          return <li key={p.id}>
            <button type="button" aria-expanded={selected} onClick={() => setOpen(selected ? null : p.id)}
              className="flex min-h-[60px] w-full items-center gap-3 px-3 py-2 text-left text-fg hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px]">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[16px] font-medium">{p.name}</span>
                <span className="block truncate text-[13px] text-fg-muted">{p.root}</span>
              </span>
              <span className="shrink-0 text-[14px] text-fg-muted">{active.error && !active.data ? 'Sessions unavailable' : !active.data ? 'Reading…' : live.length > 0 ? `${live.length} live` : 'Sessions'}</span>
              <span aria-hidden="true" className="text-[18px] text-fg-muted">{selected ? '▾' : '▸'}</span>
            </button>
            {selected && <ProjectSessions project={p} projects={projects} live={live} />}
          </li>
        })}
      </ul>}
    </section>
  )
}

function ProjectSessions({ project, projects, live }: { project: Project; projects: Project[]; live: SessionSummary[] }) {
  // Recent history only when opened. A multi-repo project reads each member;
  // worktree sessions share that member's repo_root on the wire.
  const roots = [...new Set([project.root, ...(project.repos ?? []).map((r) => r.path)])]
  const recent = useApi(async () => (await Promise.all(roots.map((root) => api.sessionsInDir(root)))).flat(), [JSON.stringify(roots)], { intervalMs: 30_000, liveMs: 5000 })
  const byId = new Map((recent.data ?? []).filter((s) => !isChat(s) && belongs(s, project, projects)).map((s) => [s.session_id, s]))
  for (const s of live) byId.set(s.session_id, s)
  const list = [...byId.values()].sort((a, b) =>
    Number(a.status === 'ended') - Number(b.status === 'ended') || (b.worked_at || b.last_event_at || 0) - (a.worked_at || a.last_event_at || 0))
  return <div className="border-t border-border bg-bg/40 px-3 py-2">
    <p className="py-1 text-[13px] text-fg-muted">Live and recent sessions</p>
    {recent.error && <p role="status" className="py-2 text-[14px] text-warn">Could not load recent sessions. <button type="button" className="min-h-11 text-accent underline" onClick={recent.refresh}>Try again</button></p>}
    {list.length === 0 && <p className="py-2 text-[14px] text-fg-muted">{!recent.data && !recent.error ? 'Reading sessions…' : recent.error ? 'Sessions are unavailable.' : 'No sessions in this project yet.'}</p>}
    {list.length > 0 && <ul className="divide-y divide-border">{list.map((s) => <li key={s.session_id}>
      <a href={href({ name: 'session', id: s.session_id, tab: 'chat' })} className="flex min-h-[56px] items-center gap-3 py-2 text-fg no-underline hover:text-accent">
        <AgentGlyph agent={s.agent || 'claude'} size={18} />
        <span className="min-w-0 flex-1 truncate text-[15px]">{s.name || s.title || s.description || shortId(s.session_id)}</span>
        <span className="shrink-0 text-[13px] text-fg-muted">{sessionHealth(s).replaceAll('-', ' ')}</span>
      </a>
    </li>)}</ul>}
  </div>
}
