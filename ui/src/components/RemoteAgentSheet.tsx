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
 * Errors are said in words, from what the daemon answered: offline (and
 * why), not allowed there yet, removed there, a folder that is not there,
 * the agent's one-time consent to accept there.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, errText, type AgentCatalog, type RecentDir } from '@/lib/api'
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
  const projects = useApi(() => far<{ projects?: { root: string; name: string }[] } | { root: string; name: string }[]>(machine, '/v1/projects'), [machine], { live: false })
  const recent = useApi(() => far<RecentDir[]>(machine, '/v1/recent-dirs'), [machine], { live: false })
  const catalog = useApi(() => far<AgentCatalog>(machine, '/v1/agents/catalog'), [machine], { live: false })
  const folders = useMemo(() => {
    const out: { path: string; label: string }[] = []
    const seen = new Set<string>()
    const pj = projects.data
    const list = Array.isArray(pj) ? pj : pj?.projects ?? []
    for (const p of list) if (p.root && !seen.has(p.root)) { seen.add(p.root); out.push({ path: p.root, label: p.name }) }
    for (const r of recent.data ?? []) if (r.dir && !seen.has(r.dir)) { seen.add(r.dir); out.push({ path: r.dir, label: r.name }) }
    return out
  }, [projects.data, recent.data])
  const agents = useMemo(() => (catalog.data?.agents ?? []).filter((a) => a.installed && !a.locked), [catalog.data])
  const [cwd, setCwd] = useState('')
  useEffect(() => { if (!cwd && folders[0]) setCwd(folders[0].path) }, [folders, cwd])
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
    : stat && !stat.exists ? <span className="text-danger">not on {name}</span>
      : stat && !stat.is_dir ? <span className="text-danger">not a folder on {name}</span>
        : stat ? `on ${name}` : undefined

  return (
    <Sheet
      label="New agent"
      title={`New agent on ${name}`}
      onClose={onClose}
      width={600}
      footer={
        <>
          {error
            ? <p role="alert" className="mr-auto min-w-0 text-[12px] leading-snug text-danger" title={error}>{error}</p>
            : <p className="mr-auto min-w-0 truncate text-[12.5px] text-fg-muted">Runs on {name}, read and typed into from here</p>}
          <SheetButton onClick={onClose} aria-keyshortcuts="Escape" title="Cancel (Esc)" keyHint="Esc">Cancel</SheetButton>
          <SheetButton
            primary
            disabled={busy || !cwd.trim()}
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
              {agents.length === 0 && <option value="claude">{catalog.error ? 'Claude Code' : 'reading…'}</option>}
              {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </SheetField>
        </div>
        {readFailed && (
          <p role="note" className="text-[12.5px] text-danger">
            {remoteStartError(projects.error, name)}
          </p>
        )}
        <SheetField label={`Folder on ${name}`} hint={folderNote}>
          <input
            className="input mono"
            aria-label={`Folder on ${name}`}
            list={`remote-folders-${machine}`}
            placeholder={folders[0]?.path ?? 'a folder on that computer'}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            spellCheck={false}
            autoFocus
          />
          <datalist id={`remote-folders-${machine}`}>
            {folders.map((f) => <option key={f.path} value={f.path}>{f.label}</option>)}
          </datalist>
        </SheetField>
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
          New copies, GitHub items and attempts are set up on {name} itself; its tab opens here when it starts.
        </p>
      </div>
    </Sheet>
  )
}
