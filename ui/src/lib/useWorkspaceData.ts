/**
 * What the app workspace shows beside its terminals: projects, sessions,
 * pending permission prompts, today's cost and the plan limits.
 *
 * Kept cheap, because it shares the main thread with the terminal (.ai/21-app.md
 * principle 3). The live socket is read through a debounced tick (at most one
 * refetch of the live sessions a second, however fast events stream), the
 * full session list and the day's summary once a minute, and permission
 * prompts straight from their frames, so a waiting badge lands within a
 * second of the prompt without polling anything.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type SessionSummary, type Summary } from './api'
import { live, useLiveTick } from './live'
import {
  deriveProjects,
  disambiguate,
  fromApiProject,
  loadLocalProjects,
  NotSupportedError,
  projectsApi,
  saveLocalProjects,
  shellAsSession,
  type ApiShell,
  type LocalProject,
  type OpFrame,
  type Project,
  type ProjectSource,
} from './projects'

const FULL_LIST_MS = 60_000
const SUMMARY_MS = 60_000
const PROJECTS_MS = 60_000
/** Shells write no session row, so their list is the only word on one ending. */
const SHELLS_MS = 10_000

/** A session's prompt as asked again after a gap: pending, none, or not known. */
export type PromptAnswer = 'pending' | 'none' | 'unknown'

/**
 * The pending-prompt set after asking every live owned session again. A
 * session no longer live drops out; one whose answer failed keeps what was
 * known. Used after a live `reset` (or a reconnect with no replay), when a
 * `permission` frame may have been missed and the badge would otherwise
 * stay wrong.
 */
export function resyncPermissions(cur: ReadonlySet<string>, answers: ReadonlyMap<string, PromptAnswer>): Set<string> {
  const next = new Set<string>()
  for (const [id, a] of answers) {
    if (a === 'pending' || (a === 'unknown' && cur.has(id))) next.add(id)
  }
  return next
}

export interface WorkspaceData {
  projects: Project[]
  source: ProjectSource
  sessions: SessionSummary[]
  /** Sessions with a permission prompt pending. */
  permissions: ReadonlySet<string>
  /** Today's spend per repository root. */
  costs: ReadonlyMap<string, number>
  summary?: Summary
  /** Clones in progress or ended in the last hour, newest first. */
  ops: OpFrame[]
  loaded: boolean
  error?: string
  refresh: () => void
  /** Add a folder in this app when the daemon keeps no project list. */
  addLocal: (p: LocalProject) => void
  /** Hide a project from the list (never touches the disk). */
  archiveLocal: (root: string) => void
}

/** Merge a fresh page of sessions over what is held, newest copy wins. */
function mergeSessions(held: SessionSummary[], fresh: SessionSummary[]): SessionSummary[] {
  const byId = new Map(held.map((s) => [s.session_id, s]))
  for (const s of fresh) if (s?.session_id) byId.set(s.session_id, s)
  return [...byId.values()]
}

export function useWorkspaceData(): WorkspaceData {
  const tick = useLiveTick(1000)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [apiProjects, setApiProjects] = useState<Project[] | null>(null)
  const [shells, setShells] = useState<ApiShell[]>([])
  const [ops, setOps] = useState<OpFrame[]>([])
  const [source, setSource] = useState<ProjectSource>('api')
  const [local, setLocal] = useState<LocalProject[]>(() => loadLocalProjects())
  const [permissions, setPermissions] = useState<Set<string>>(() => new Set())
  const [summary, setSummary] = useState<Summary | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  const asked = useRef(new Set<string>())
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  // The full list, for projects nobody is working in right now.
  useEffect(() => {
    let alive = true
    const load = () => api.sessions(false)
      .then((list) => { if (alive) { setSessions((cur) => mergeSessions(cur, list)); setLoaded(true); setError(undefined) } })
      .catch((e: unknown) => { if (alive) { setLoaded(true); setError(e instanceof Error ? e.message : String(e)) } })
    void load()
    const id = window.setInterval(load, FULL_LIST_MS)
    return () => { alive = false; window.clearInterval(id) }
  }, [nonce])

  // The live ones, on the debounced tick.
  useEffect(() => {
    if (tick === 0) return
    let alive = true
    api.sessions(true)
      .then((list) => { if (alive) setSessions((cur) => mergeSessions(cur, list)) })
      .catch(() => { /* the full list's error already speaks */ })
    return () => { alive = false }
  }, [tick])

  // The daemon's project list, or the derived one when it has none.
  useEffect(() => {
    let alive = true
    const load = () => projectsApi.list()
      .then((list) => { if (alive) { setApiProjects(list); setSource('api') } })
      .catch((e: unknown) => {
        if (!alive) return
        if (e instanceof NotSupportedError) { setApiProjects(null); setSource('derived') }
      })
    void load()
    const id = window.setInterval(load, PROJECTS_MS)
    return () => { alive = false; window.clearInterval(id) }
  }, [nonce])

  // Shells: no session row, no live frame, so their own list.
  useEffect(() => {
    let alive = true
    const load = () => projectsApi.shells()
      .then((list) => { if (alive) setShells(list) })
      .catch(() => { if (alive) setShells([]) })
    void load()
    const id = window.setInterval(load, SHELLS_MS)
    return () => { alive = false; window.clearInterval(id) }
  }, [nonce])

  // Git state, clones and permission prompts, as they happen.
  useEffect(() => {
    let hellos = 0
    // Frames were lost (a `reset`, or a reconnect the daemon could not
    // replay): a missed `permission` frame would leave a prompt or the badge
    // stale, so every live owned session is asked again.
    const resync = () => {
      const owned = sessionsRef.current.filter((s) => s.owned && s.status !== 'ended' && s.kind !== 'shell')
      void Promise.all(owned.map((s) => api.permission(s.session_id)
        .then((r): [string, PromptAnswer] => [s.session_id, r.permission ? 'pending' : 'none'])
        .catch((): [string, PromptAnswer] => [s.session_id, 'unknown'])))
        .then((pairs) => setPermissions((cur) => resyncPermissions(cur, new Map(pairs))))
    }
    return live.onFrame((frame) => {
    if (frame.type === 'reset') {
      resync()
    } else if (frame.type === 'hello') {
      // The first hello is the page opening (asked below); a later one
      // without replay (`reset`, or a daemon that predates it) left a gap.
      if (hellos++ > 0 && frame.data.reset !== false) resync()
    } else if (frame.type === 'project') {
      const id = String(frame.data.id)
      if (frame.data.removed) {
        setApiProjects((cur) => cur && cur.filter((x) => x.id !== id))
        return
      }
      const p = fromApiProject(frame.data)
      setApiProjects((cur) => {
        if (!cur) return cur
        const at = cur.findIndex((x) => x.id === id)
        return at >= 0 ? cur.map((x, i) => (i === at ? p : x)) : [...cur, p]
      })
    } else if (frame.type === 'op') {
      const op = frame.data
      setOps((cur) => [op, ...cur.filter((o) => o.op_id !== op.op_id)])
    } else if (frame.type === 'session') {
      // A session's row changed — most usefully, it ended, which the live
      // list (active sessions only) cannot say by omission.
      const d = frame.data as { session?: Partial<SessionSummary>; stats?: SessionSummary['stats'] }
      const id = d.session?.session_id
      if (!id) return
      setSessions((cur) => {
        const at = cur.findIndex((s) => s.session_id === id)
        if (at < 0) return cur
        const next = cur.slice()
        next[at] = { ...cur[at]!, ...d.session, stats: d.stats ?? cur[at]!.stats } as SessionSummary
        return next
      })
    } else if (frame.type === 'permission') {
      const d = frame.data
      setPermissions((cur) => {
        const has = cur.has(d.session_id)
        if (has === !!d.permission) return cur
        const next = new Set(cur)
        if (d.permission) next.add(d.session_id)
        else next.delete(d.session_id)
        return next
      })
    }
    })
  }, [])

  // A prompt already pending when the app opened is not announced again:
  // ask once for each live session Caprock owns.
  useEffect(() => {
    for (const s of sessions) {
      if (!s.owned || s.status === 'ended' || s.kind === 'shell' || asked.current.has(s.session_id)) continue
      asked.current.add(s.session_id)
      api.permission(s.session_id)
        .then((r) => {
          if (!r.permission) return
          setPermissions((cur) => (cur.has(s.session_id) ? cur : new Set(cur).add(s.session_id)))
        })
        .catch(() => { /* an older daemon: no prompts */ })
    }
  }, [sessions])

  useEffect(() => {
    let alive = true
    const load = () => api.summary('today')
      .then((s) => { if (alive) setSummary(s) })
      .catch(() => { /* the strip shows what it last knew */ })
    void load()
    const id = window.setInterval(load, SUMMARY_MS)
    return () => { alive = false; window.clearInterval(id) }
  }, [nonce])

  const costs = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of summary?.projects ?? []) {
      const dir = (p as { dir?: string }).dir
      if (dir) m.set(dir, (m.get(dir) ?? 0) + (p.cost_usd ?? 0))
    }
    return m
  }, [summary])

  const labels = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of summary?.projects ?? []) {
      const dir = (p as { dir?: string }).dir
      if (dir && p.project) m.set(dir, p.project)
    }
    return m
  }, [summary])

  const allSessions = useMemo(
    () => (shells.length === 0 ? sessions : [...sessions.filter((s) => s.kind !== 'shell'), ...shells.map(shellAsSession)]),
    [sessions, shells],
  )

  const projects = useMemo(
    () => (source === 'api' && apiProjects ? disambiguate(apiProjects) : deriveProjects(sessions, local, labels)),
    [source, apiProjects, sessions, local, labels],
  )

  const addLocal = useCallback((p: LocalProject) => {
    setLocal((cur) => {
      const next = [...cur.filter((x) => x.root !== p.root), p]
      saveLocalProjects(next)
      return next
    })
  }, [])
  const archiveLocal = useCallback((root: string) => {
    setLocal((cur) => {
      const known = cur.find((x) => x.root === root)
      const next = known
        ? cur.map((x) => (x.root === root ? { ...x, archived: true } : x))
        : [...cur, { root, name: root, archived: true }]
      saveLocalProjects(next)
      return next
    })
  }, [])

  return { projects, source, sessions: allSessions, permissions, costs, summary, ops, loaded, error, refresh, addLocal, archiveLocal }
}
