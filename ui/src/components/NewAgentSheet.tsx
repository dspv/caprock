/**
 * New agent (⇧⌘N): which agent, which model, what it may do without asking,
 * where — the project's checkout, one of its worktrees, or a new worktree —
 * and, optionally, what to say first. The same `POST /v1/agents` the
 * dashboard's dialog and the phone use; the tab opens on success.
 *
 * Filled entirely from the keyboard (owner, 2026-10-07): focus opens on the
 * first message; Tab and ⇧Tab walk Project, Where, Agent, Model, Permissions,
 * First message, Cancel, Start in that order; ↑ and ↓ change a select in
 * place; ⌘↩ starts from anywhere in the sheet, the buttons included; Esc
 * cancels. The keys are named in the footer, not only in the docs.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errText } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { AgentPicker, spawnableAgents, useAgentChoice } from './AgentPicker'
import { DEFAULT_MODE, DEFAULT_MODELS, GEMINI_MAPPED, MODE_NOTE, ModelField, modeOptions } from './SpawnDialog'
import { useInitialMode } from '@/lib/permissionMode'
import type { SpawnAgent } from './AgentPicker'
import type { Project } from '@/lib/projects'
import { ProjectInstructions } from './ProjectInstructions'
import { Sheet, SheetButton, SheetField } from './Sheet'
import { stepSelect } from '@/lib/selectKeys'
import { BypassConsentNote, useBypassConsent } from './BypassConsent'

const NEW_WORKTREE = '__new__'

export function NewAgentSheet({
  projects,
  projectId,
  cwd: initialCwd,
  prompt: initialPrompt = '',
  worktree: initialWorktree,
  onClose,
  onStarted,
}: {
  projects: Project[]
  projectId?: string
  /** A worktree's folder, when the sheet was opened from one. */
  cwd?: string
  /** A first message already typed (the palette's "new task"). */
  prompt?: string
  /** A new worktree's name, proposed: the sheet opens on "New worktree…" with it filled in. */
  worktree?: string
  onClose: () => void
  onStarted: (sessionId: string, projectId: string, title: string) => void
}) {
  const status = useApi(() => api.status(), [], { live: false })
  const agents = useMemo(() => spawnableAgents(status.data), [status.data])
  const checking = !status.data && !status.error
  const [agent, setAgent] = useAgentChoice(agents)
  const [pid, setPid] = useState(projectId ?? projects[0]?.id ?? '')
  const project = projects.find((p) => p.id === pid)
  const worktrees = useMemo(() => (project?.worktrees ?? []).filter((w) => w.path !== project?.root), [project])
  const [where, setWhere] = useState(initialWorktree ? NEW_WORKTREE : initialCwd && initialCwd !== project?.root ? initialCwd : '')
  const [newBranch, setNewBranch] = useState(initialWorktree ?? '')
  const [models, setModels] = useState<Record<SpawnAgent, string>>(DEFAULT_MODELS)
  const [mode, setMode] = useInitialMode(DEFAULT_MODE)
  const [prompt, setPrompt] = useState(initialPrompt)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const consent = useBypassConsent(agent, mode)
  const codexModels = useApi(() => (agent === 'codex' ? api.agentModels('codex') : Promise.resolve(undefined)), [agent], { live: false })

  // ⌘↩ from anywhere in the sheet — a select, the footer's buttons — not only
  // from the fields' grid. A ref keeps the listener on the latest state.
  const startRef = useRef<() => void>(() => {})
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      startRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const start = async () => {
    if (!project) { setError('Pick a project first.'); return }
    if (where === NEW_WORKTREE && !/^[\w./-]+$/.test(newBranch.trim())) { setError('Name the new worktree: letters, digits, dot, dash, slash.'); return }
    setBusy(true)
    setError('')
    try {
      if (consent.needed) await consent.accept()
      const req: Parameters<typeof api.spawn>[0] = { cwd: where && where !== NEW_WORKTREE ? where : project.root }
      if (agent !== 'claude') req.agent = agent
      if (models[agent]?.trim()) req.model = models[agent].trim()
      if (mode) req.permission_mode = mode
      if (where === NEW_WORKTREE) req.worktree = newBranch.trim()
      if (prompt.trim()) req.prompt = prompt.trim()
      const { session_id } = await api.spawn(req)
      onStarted(session_id, project.id, prompt.trim().slice(0, 60) || 'new session')
      onClose()
    } catch (e) {
      if (!consent.noteRefusal(e)) setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  startRef.current = () => { if (!busy && agents.length > 0) void start() }

  return (
    <Sheet
      label="New agent"
      title="New agent"
      onClose={onClose}
      footer={
        <>
          {error
            ? <p role="alert" className="mr-auto min-w-0 truncate text-[12px] text-danger" title={error}>{error}</p>
            : (
              <p className="mr-auto min-w-0 truncate text-[11.5px] text-fg-faint" aria-label="Keys: Tab moves, arrows change a choice, Command Enter starts, Escape cancels">
                <span className="mono">Tab</span> moves · <span className="mono">↑↓</span> change · <span className="mono">⌘↩</span> starts · <span className="mono">Esc</span> cancels
              </p>
            )}
          <SheetButton onClick={onClose}>Cancel</SheetButton>
          <SheetButton primary disabled={busy || agents.length === 0} onClick={() => void start()}>{busy ? 'Starting…' : consent.needed ? 'Accept and start' : 'Start'}</SheetButton>
        </>
      }
    >
      {checking ? (
        <div className="h-[320px]" />
      ) : agents.length === 0 ? (
        <p className="px-5 py-5 text-[13px] text-fg-muted">
          No agent Caprock can start was found on this machine — not <span className="mono">claude</span>, <span className="mono">codex</span>, <span className="mono">opencode</span> or <span className="mono">gemini</span>.
        </p>
      ) : (
        <div className="grid gap-4 px-5 py-4" onKeyDown={(e) => { stepSelect(e) }}>
          <div className="grid grid-cols-2 gap-3">
            <SheetField label="Project">
              <select className="input" value={pid} onChange={(e) => { setPid(e.target.value); setWhere('') }}>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </SheetField>
            <SheetField label="Where">
              <select className="input" value={where} onChange={(e) => setWhere(e.target.value)}>
                <option value="">{project?.branch ? `${project.branch} · main checkout` : 'main checkout'}</option>
                {worktrees.map((w) => <option key={w.path} value={w.path}>{w.branch} · {w.name}</option>)}
                {initialCwd && initialCwd !== project?.root && !worktrees.some((w) => w.path === initialCwd) && <option value={initialCwd}>{initialCwd}</option>}
                <option value={NEW_WORKTREE}>New worktree…</option>
              </select>
            </SheetField>
          </div>
          {where === NEW_WORKTREE && (
            <SheetField label="Worktree name" hint="a new branch, checked out in .caprock-worktrees/<name>">
              <input className="input" autoFocus={!initialPrompt} placeholder="feature-x" value={newBranch} onChange={(e) => setNewBranch(e.target.value)} />
            </SheetField>
          )}
          <div className="grid grid-cols-2 gap-3">
            {agents.length > 1 ? <AgentPicker value={agent} agents={agents} onChange={setAgent} /> : <div />}
            <SheetField label="Model">
              <ModelField agent={agent} value={models[agent]} onChange={(v) => setModels((m) => ({ ...m, [agent]: v }))} codex={codexModels.data} />
            </SheetField>
          </div>
          <SheetField label="Permissions">
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
              {modeOptions(mode).map(([v, label]) => (
                <option key={v} value={v}>
                  {agent === 'gemini' && !GEMINI_MAPPED.has(v) ? `${label} · Gemini asks instead` : MODE_NOTE[agent]?.[v] ?? label}
                </option>
              ))}
            </select>
          </SheetField>
          {consent.needed && <BypassConsentNote />}
          {project && (agent === 'claude' || agent === 'codex') && <ProjectInstructions key={project.id} project={project} />}
          <SheetField label="First message" hint="optional">
            <textarea
              className="input min-h-[84px] resize-y font-[family-name:var(--font-sans)] text-[13px] leading-relaxed"
              autoFocus={where !== NEW_WORKTREE || !!initialPrompt}
              placeholder="What should it do?"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </SheetField>
        </div>
      )}
    </Sheet>
  )
}
