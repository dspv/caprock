/**
 * New agent on another computer (ADR-067, Phase 2): the owner's goal
 * (2026-10-27, translated) — "put Caprock on a desktop at home and drive it
 * from the laptop; agents run on the home machine".
 *
 * New agent's **Machine** picker (`MachinePicker`) shows *This Mac* and every
 * computer this one reaches; one that cannot take a start (waiting for Allow
 * there, removed there, another key, offline) is listed, disabled, with why.
 * Picking another computer turns the sheet into this one: everything it
 * offers is read **from that computer**, through `/v1/m/<id>/…` — its
 * projects and recent folders for Folder, whether the folder typed exists
 * there (`GET /v1/browse/stat`), its agents and their models — and Start is
 * that computer's `POST /v1/agents`, run there by its own daemon (rule 7: it
 * starts what it then owns). The tab that opens is the session there,
 * `#/m/<id>/session/<sid>`.
 *
 * What it does not carry over from this computer's sheet, by design: new
 * copies (worktrees), GitHub items, attempts and subscriptions are that
 * computer's own business and are set up there; this is the short path —
 * where, which agent, what it may do, what to say first.
 *
 * **The folder is chosen, not typed** (owner, 2026-11-20, translated, on a
 * fresh Windows PC: "I don't see the folders there and don't understand what
 * I can work with"). Under the field, DirPicker with that computer as its
 * source: *Projects* (its projects, then its recent folders) and *Browse*
 * (`GET /v1/browse`, opening in its `dev` folder in the home, or the home
 * without one; a click opens a folder and picks it, the breadcrumb goes
 * back). Typing a path still works. With no projects there it says so and
 * offers **Clone a repository** — `POST /v1/projects {clone}` on that
 * computer into its `dev` folder, followed with an op id as the phone
 * follows one (CloneTracker, `GET /v1/projects/ops` every second), the new
 * folder picked when done — and **Pick a folder** (Browse).
 *
 * Errors are said in words, from what the daemon answered: offline (and
 * why), not allowed there yet, removed there, a folder that is not there,
 * the agent's one-time consent to accept there.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, errText, type AgentCatalog, type BrowseResponse, type RecentDir } from '@/lib/api'
import { newOpId, type AddProjectRequest, type AddProjectResult, type OpFrame } from '@/lib/projects'
import { CloneTracker, isPhoneCloneURL, repoName, type CloneView } from '@/lib/startwork'
import { DirPicker, type DirSource, type PickerTab } from './DirPicker'
import { MACHINES_EVENT, machineBase, machineLook, offlineWhy, useAllMachineSessions, type Machine, type MachineSessionsEntry } from '@/lib/machines'
import { useApi } from '@/lib/useApi'
import { isMacPlatform } from '@/lib/appmode'
import { useInitialMode } from '@/lib/permissionMode'
import { stepSelect } from '@/lib/selectKeys'
import { DEFAULT_MODE, MODE_NOTE, modeOptions } from './SpawnDialog'
import type { SpawnAgent } from './AgentPicker'
import { Sheet, SheetButton, SheetField } from './Sheet'

/** What this computer is called in the picker. */
export function thisComputer(): string {
  return isMacPlatform() ? 'This Mac' : 'This computer'
}

/** Whether a computer can take a start now, and if not, the word for why. */
export function machineStartable(m: Machine, entry?: MachineSessionsEntry): { ok: boolean; why?: string } {
  // The one list was read later than the machines list: it wins.
  const status = entry?.status ?? m.status
  const look = machineLook({ ...m, status: (status as Machine['status']) })
  if (status === 'offline') return { ok: false, why: 'offline' }
  if (status === 'error') return { ok: true }
  if (!look.reachable) return { ok: false, why: look.label }
  return { ok: true }
}

/**
 * New agent's Machine field: This Mac first, then each computer this one
 * reaches. Drawn only when there is another computer, so a single machine's
 * sheet looks as it always did.
 */
export function MachinePicker({ machines, value, onChange }: { machines: readonly Machine[]; value: string; onChange: (id: string) => void }) {
  const one = useAllMachineSessions(machines.length > 0)
  const entries = one.data ?? []
  return (
    <SheetField label="Machine" hint={value ? 'runs there' : undefined}>
      <select className="input" aria-label="Machine" value={value} onChange={(e) => onChange(e.target.value)} data-machine-picker>
        <option value="">{thisComputer()}</option>
        {machines.map((m) => {
          const st = machineStartable(m, entries.find((e) => e.id === m.id))
          return (
            <option key={m.id} value={m.id} disabled={!st.ok && m.id !== value}>
              {st.ok ? m.name : `${m.name} · ${st.why}`}
            </option>
          )
        })}
      </select>
    </SheetField>
  )
}

/** A remote read through the proxy; the error body is kept for the words. */
async function far<T>(machine: string, path: string, init?: RequestInit): Promise<T> {
  const write = !!init?.method && init.method !== 'GET'
  const res = await fetch(`${machineBase(machine)}${path}`, { ...init, headers: { Accept: 'application/json', ...(write ? { 'Content-Type': 'application/json' } : {}) } })
  if (!res.ok) {
    let body: unknown
    try { body = await res.json() } catch { /* not JSON */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body)
  }
  return (await res.json()) as T
}

/** The words for a start the other computer, or the way to it, refused. */
export function remoteStartError(e: unknown, name: string): string {
  if (!(e instanceof ApiError)) return errText(e)
  const b = (e.body ?? {}) as { error?: string; status?: string; code?: string }
  const err = b.error ?? ''
  if (b.status === 'offline') return `${name} is offline. ${offlineWhy(err)}`
  if (b.status === 'revoked') return `${name} removed this computer. Show a new link there and add it again in Settings → Computers.`
  if (b.status === 'refused') return `${name} answered with another key. Add it again with a new link from it.`
  if (e.status === 403 && /waiting to be allowed/i.test(err)) return `${name} has not allowed this computer yet: press Allow there, or run caprock machines allow on it.`
  if (e.status === 403) return `${name} does not let this computer start agents: ${err || 'not allowed'}.`
  if (b.code === 'bypass_consent') return `The agent on ${name} has not accepted its one-time warning for skipping permissions. Accept it there once, or pick another mode.`
  if (e.status === 400 && /is not a directory/i.test(err)) return `That folder is not on ${name}. Pick one of its folders, or create it there first.`
  if (e.status === 504) return `${name} did not answer in time.`
  return err ? `${name}: ${err}` : `${name} refused the start (${e.status}).`
}

interface Stat { path: string; exists: boolean; is_dir: boolean }

export function RemoteAgentSheet({ machines, machine, onMachine, prompt: initialPrompt = '', onClose, onStarted }: {
  machines: readonly Machine[]
  machine: string
  onMachine: (id: string) => void
  prompt?: string
  onClose: () => void
  /** The session started there. */
  onStarted: (machine: string, sessionId: string, title: string) => void
}) {
  const m = machines.find((x) => x.id === machine)
  const name = m?.name ?? 'the other computer'
  // Read from that computer: its folders, and its agents.
  const [reread, setReread] = useState(0)
  const projects = useApi(() => far<{ projects?: { root: string; name: string }[] } | { root: string; name: string }[]>(machine, '/v1/projects'), [machine, reread], { live: false })
  const recent = useApi(() => far<RecentDir[]>(machine, '/v1/recent-dirs'), [machine], { live: false })
  const catalog = useApi(() => far<AgentCatalog>(machine, '/v1/agents/catalog'), [machine], { live: false })
  const projectList = useMemo(() => {
    const pj = projects.data
    return (Array.isArray(pj) ? pj : pj?.projects ?? []).filter((p) => p.root)
  }, [projects.data])
  // A folder just cloned there, listed first until its project is read back.
  const [cloned, setCloned] = useState('')
  const folders = useMemo(() => {
    const out: RecentDir[] = []
    const seen = new Set<string>()
    if (cloned && !projectList.some((p) => p.root === cloned)) { seen.add(cloned); out.push({ dir: cloned, name: cloned.split(/[\\/]/).pop() || cloned, sessions: 0, last_event_at: 0 }) }
    for (const p of projectList) if (!seen.has(p.root)) { seen.add(p.root); out.push({ dir: p.root, name: p.name, sessions: 0, last_event_at: 0 }) }
    for (const r of recent.data ?? []) if (r.dir && !seen.has(r.dir)) { seen.add(r.dir); out.push(r) }
    return out
  }, [cloned, projectList, recent.data])
  // Read, and nothing there: say what to do instead of an empty field.
  const noProjects = Boolean(projects.data) && projectList.length === 0
  const source = useMemo<DirSource>(() => ({
    key: machine,
    browse: (dir) => far<BrowseResponse>(machine, `/v1/browse${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`).catch((e: unknown) => {
      // Its 404 is "not a folder it lets this computer see"; the rest in words.
      throw new Error(e instanceof ApiError && e.status === 404 ? `Not a folder ${name} lets this computer see.` : remoteStartError(e, name))
    }),
    rows: projects.data || recent.data || projects.error ? folders : undefined,
    rowsLabel: 'Projects',
    rowsEmpty: `No projects on ${name} yet. Browse its folders, or type a path.`,
  }), [machine, folders, projects.data, recent.data, projects.error, name])
  const [tab, setTab] = useState<PickerTab>('recent')
  // What the Folder field shows under it: the lists, the empty state, or the clone.
  const [view, setView] = useState<'lists' | 'clone' | null>(null)
  const shown = view ?? (noProjects ? 'empty' : 'lists')
  const agents = useMemo(() => (catalog.data?.agents ?? []).filter((a) => a.installed && !a.locked), [catalog.data])
  // Its catalog answered and nothing in it is installed: said in words, since
  // the field's "reading…" then never ends (owner, 2026-11-20, on a Windows
  // PC with Caprock and no Claude Code yet).
  const noAgent = Boolean(catalog.data) && agents.length === 0
  const [cwd, setCwd] = useState('')
  useEffect(() => { if (!cwd && folders[0]) setCwd(folders[0].dir) }, [folders, cwd])
  const [agent, setAgent] = useState('claude')
  useEffect(() => { const first = agents[0]; if (first && !agents.some((a) => a.id === agent)) setAgent(first.id) }, [agents, agent])
  const entry = agents.find((a) => a.id === agent)
  const [model, setModel] = useState('')
  const [mode, setMode, rememberMode] = useInitialMode(DEFAULT_MODE)
  const [prompt, setPrompt] = useState(initialPrompt)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Whether the folder typed is there, said as it is typed (debounced).
  const [stat, setStat] = useState<Stat | null | 'outside'>(null)
  useEffect(() => {
    const p = cwd.trim()
    setStat(null)
    if (!p) return
    let alive = true
    const t = window.setTimeout(() => {
      far<Stat>(machine, `/v1/browse/stat?path=${encodeURIComponent(p)}`)
        .then((s) => { if (alive) setStat(s) })
        .catch((e: unknown) => { if (alive && e instanceof ApiError && e.status === 404) setStat('outside') })
    }, 250)
    return () => { alive = false; window.clearTimeout(t) }
  }, [cwd, machine])

  const custom = agent.startsWith('custom:')
  const start = async () => {
    if (!cwd.trim()) { setError(`Pick a folder on ${name}.`); return }
    setBusy(true)
    setError('')
    try {
      const req: Record<string, unknown> = { cwd: cwd.trim() }
      if (agent !== 'claude') req.agent = agent
      if (model.trim()) req.model = model.trim()
      if (mode && !custom) req.permission_mode = mode
      if (prompt.trim()) req.prompt = prompt.trim()
      const res = await far<{ session_id: string }>(machine, '/v1/agents', { method: 'POST', body: JSON.stringify(req) })
      rememberMode()
      // Every list on the page reads the one list again: it is there now.
      window.dispatchEvent(new Event(MACHINES_EVENT))
      onStarted(machine, res.session_id, prompt.trim().slice(0, 60) || `new session on ${name}`)
      onClose()
    } catch (e) {
      setError(remoteStartError(e, name))
    } finally {
      setBusy(false)
    }
  }
  const startRef = useRef(start)
  startRef.current = start
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      if (!busy) void startRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [busy])
  const startKey = isMacPlatform() ? '⌘↩' : 'Ctrl+↵'
  const readFailed = projects.error && recent.error && catalog.error
  const folderNote = stat === 'outside'
    ? <span className="text-danger">outside what {name} lets this computer reach</span>
    : stat && !stat.exists ? <span className="text-danger">not there</span>
      : stat && !stat.is_dir ? <span className="text-danger">not a folder</span>
        : stat ? 'found there' : undefined

  return (
    <Sheet
      label="New agent"
      title={`New agent on ${name}`}
      onClose={onClose}
      width={600}
      footer={
        <>
          {/* basis-0: the line takes what the buttons leave and never pushes
            * Start onto a row of its own (owner, 2026-11-20). */}
          {error
            ? <p role="alert" data-sheet-note className="mr-auto min-w-0 flex-1 basis-0 text-[12px] leading-snug text-danger" title={error}>{error}</p>
            : <p data-sheet-note className="mr-auto min-w-0 flex-1 basis-0 truncate text-[12.5px] text-fg-muted" title={`Runs on ${name}`}>Runs on {name}</p>}
          <SheetButton onClick={onClose} aria-keyshortcuts="Escape" title="Cancel (Esc)" keyHint="Esc">Cancel</SheetButton>
          <SheetButton
            primary
            disabled={busy || !cwd.trim() || noAgent}
            onClick={() => void start()}
            aria-keyshortcuts={isMacPlatform() ? 'Meta+Enter' : 'Control+Enter'}
            title={`Start on ${name} (${startKey})`}
            keyHint={busy ? undefined : startKey}
          >
            {busy ? 'Starting…' : 'Start'}
          </SheetButton>
        </>
      }
    >
      <div className="grid gap-4 px-5 py-4" data-remote-agent={machine} onKeyDown={(e) => { stepSelect(e) }}>
        <div className="grid grid-cols-2 gap-3">
          <MachinePicker machines={machines} value={machine} onChange={onMachine} />
          <SheetField label="Agent">
            <select className="input" aria-label="Agent" value={agent} onChange={(e) => { setAgent(e.target.value); setModel('') }} disabled={agents.length === 0}>
              {agents.length === 0 && <option value="claude">{catalog.error ? 'Claude Code' : noAgent ? 'none installed there' : 'reading…'}</option>}
              {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </SheetField>
        </div>
        {readFailed && (
          <p role="note" className="text-[12.5px] text-danger">
            {remoteStartError(projects.error, name)}
          </p>
        )}
        {noAgent && (
          <p role="note" data-no-agent className="text-[12.5px] text-warn">
            No agent is installed on {name}. Install Claude Code or another agent there and sign in, restart Caprock on it, then open this again.
          </p>
        )}
        <div className="grid min-w-0 gap-1.5" data-remote-folder>
          <span className="flex items-baseline gap-2 text-[13px] font-medium text-fg-muted">
            <label htmlFor={`remote-folder-${machine}`} className="min-w-0 truncate" title={`Folder on ${name}`}>Folder on {name}</label>
            {folderNote && <span className="shrink-0 font-normal text-fg-faint">{folderNote}</span>}
            {shown === 'lists' && (
              <button type="button" onClick={() => setView('clone')} className="ml-auto shrink-0 text-[12px] font-normal text-accent hover:underline">Clone a repository…</button>
            )}
          </span>
          <input
            id={`remote-folder-${machine}`}
            className="input mono"
            aria-label={`Folder on ${name}`}
            placeholder={folders[0]?.dir ?? `pick one below, or type a folder on ${name}`}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            spellCheck={false}
            autoFocus
          />
          {shown === 'empty' ? (
            <div role="group" aria-label={`No projects on ${name}`} data-remote-empty className="grid gap-2.5 rounded-[3px] border border-border-strong bg-panel-2 px-3 py-3">
              <p className="text-[13px] text-fg">No projects on {name} yet.</p>
              <p className="text-[12px] leading-snug text-fg-muted">Clone a repository there, or pick one of its folders to start in.</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setView('clone')} className="rounded-[5px] bg-accent px-3 py-1 text-[12.5px] font-medium text-panel hover:brightness-110">Clone a repository</button>
                <button type="button" onClick={() => { setTab('browse'); setView('lists') }} className="rounded-[5px] border border-border-strong px-3 py-1 text-[12.5px] text-fg hover:bg-panel">Pick a folder</button>
              </div>
            </div>
          ) : shown === 'clone' ? (
            <RemoteClone
              machine={machine}
              name={name}
              home={catalog.data?.home}
              onCancel={() => setView(null)}
              onCloned={(dest) => { setCloned(dest); setCwd(dest); setView('lists'); setTab('recent'); setReread((n) => n + 1) }}
            />
          ) : (
            <DirPicker value={cwd.trim()} onPick={setCwd} start="~/dev" tab={tab} onTab={setTab} source={source} />
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <SheetField label="Model" hint="optional">
            <input
              className="input"
              aria-label="Model"
              list={`remote-models-${machine}`}
              placeholder={entry?.default || 'its default'}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              spellCheck={false}
            />
            <datalist id={`remote-models-${machine}`}>
              {(entry?.models ?? []).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </datalist>
          </SheetField>
          {!custom ? (
            <SheetField label="Permissions" hint="kept for the next agent">
              <select className="input" aria-label="Permissions" value={mode} onChange={(e) => setMode(e.target.value)}>
                {modeOptions(mode).map(([v, label]) => <option key={v} value={v}>{MODE_NOTE[agent as SpawnAgent]?.[v] ?? label}</option>)}
              </select>
            </SheetField>
          ) : <div />}
        </div>
        <SheetField label="First message" hint="optional">
          <textarea
            className="input min-h-[84px] resize-y font-[family-name:var(--font-sans)] text-[13px] leading-relaxed"
            placeholder="What should it do?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </SheetField>
        <p className="text-[12px] leading-snug text-fg-faint">
          New copies and attempts are made on {name} itself.
        </p>
      </div>
    </Sheet>
  )
}

/** The separator a computer writes its paths with: a Windows home has no `/`. */
export function sepOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

/** `dir` and `name` joined as that computer writes it. */
export function joinOn(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}${sepOf(dir)}${name}`
}

/**
 * Clone a repository on another computer, into its `dev` folder in the home
 * (made if missing, as `git clone` makes it): `POST /v1/projects {clone}`
 * through the proxy with an op id, followed as the phone follows one
 * (CloneTracker), and the new folder handed back when it is done.
 */
export function RemoteClone({ machine, name, home, onCancel, onCloned }: {
  machine: string
  name: string
  /** That computer's home, as its catalog says it; else read from its browse root. */
  home?: string
  onCancel: () => void
  onCloned: (dest: string) => void
}) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [cloning, setCloning] = useState<CloneView | null>(null)
  // Where it lands: its dev folder as it spells it — the folder itself when
  // there is one, else the home (or browse root) plus dev.
  const where = useApi(async () => {
    try {
      return (await far<BrowseResponse>(machine, `/v1/browse?dir=${encodeURIComponent('~/dev')}`)).dir
    } catch {
      const base = home || (await far<BrowseResponse>(machine, '/v1/browse')).root
      return joinOn(base, 'dev')
    }
  }, [machine, home], { live: false })
  const dev = where.data ?? ''
  const u = url.trim()
  const dest = dev && u && isPhoneCloneURL(u) && repoName(u) ? joinOn(dev, repoName(u)) : ''
  const tracker = useRef<CloneTracker | null>(null)
  useEffect(() => () => tracker.current?.stop(), [])
  const done = useRef(onCloned)
  done.current = onCloned

  const clone = () => {
    if (!isPhoneCloneURL(u)) { setError('Paste an https:// address, or git@host:owner/repo.'); return }
    if (!dev) { setError(`Could not read the folders on ${name}.`); return }
    setError('')
    tracker.current?.stop()
    const apis = {
      ops: async (): Promise<OpFrame[]> => (await far<{ ops?: OpFrame[] }>(machine, '/v1/projects/ops')).ops ?? [],
      add: async (req: AddProjectRequest): Promise<AddProjectResult> => {
        const v = await far<{ op?: OpFrame; existing?: boolean }>(machine, '/v1/projects', { method: 'POST', body: JSON.stringify(req) })
        if (!v.op) throw new Error(`${name} answered without the clone.`)
        return { op: v.op, existing: !!v.existing }
      },
    }
    const t = new CloneTracker({ op_id: newOpId(), url: u, parent: dev, started_at: Date.now() }, (v) => {
      setCloning(v)
      if (v.phase === 'done') done.current(v.op.dest || dest)
    }, apis, { pollMs: 1000, keep: false })
    tracker.current = t
    setCloning({ phase: 'sending' })
    t.start()
  }

  const busy = cloning && cloning.phase !== 'failed' && cloning.phase !== 'done'
  const op = cloning && 'op' in cloning ? cloning.op : undefined
  const pct = Math.max(0, Math.min(100, Math.round(op?.progress ?? 0)))
  const failed = cloning?.phase === 'failed' ? cloning.error : ''
  const said = error || (failed ? `Clone failed: ${failed}` : '')
  const status = cloning?.phase === 'offline'
    ? `${name} cannot be reached right now. The clone goes on there if it started; trying again…`
    : cloning?.phase === 'sending' ? `Starting the clone on ${name}…`
      : cloning?.phase === 'running' ? `${op?.phase || 'Cloning'}… ${pct}%` : ''

  return (
    <div role="group" aria-label={`Clone a repository on ${name}`} data-remote-clone className="grid gap-2 rounded-[3px] border border-border-strong bg-panel-2 px-3 py-3">
      <span className="text-[13px] text-fg">Clone a repository on {name}</span>
      <input
        className="input mono"
        aria-label="Repository address"
        placeholder="https://github.com/you/repo.git"
        value={url}
        onChange={(e) => { setUrl(e.target.value); setError('') }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !busy) { e.preventDefault(); clone() } }}
        disabled={!!busy}
        spellCheck={false}
        autoFocus
      />
      <p className="min-w-0 text-[12px] leading-snug text-fg-muted">
        Into <span className="mono break-all text-fg" data-clone-dest>{dest || (dev ? joinOn(dev, '…') : 'its dev folder')}</span>
      </p>
      {busy ? (
        <div className="grid gap-1.5" aria-live="polite">
          <span className="text-[12px] text-fg-muted">{status}</span>
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Clone progress" className="h-1.5 overflow-hidden rounded-full bg-panel">
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${cloning?.phase === 'running' ? Math.max(pct, 4) : 4}%` }} />
          </div>
        </div>
      ) : null}
      {said && <p role="alert" className="text-[12px] leading-snug text-danger">{said}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={!!busy || !u} onClick={clone} className="rounded-[5px] bg-accent px-3 py-1 text-[12.5px] font-medium text-panel hover:brightness-110 disabled:opacity-50">
          {failed ? 'Try again' : busy ? 'Cloning…' : 'Clone'}
        </button>
        {!busy && <button type="button" onClick={onCancel} className="rounded-[5px] px-2 py-1 text-[12.5px] text-fg-muted hover:text-fg">Back</button>}
      </div>
    </div>
  )
}
