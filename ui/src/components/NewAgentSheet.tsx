/**
 * New agent (⇧⌘N): which agent, which model, what it may do without asking,
 * where — the project's checkout, one of its worktrees, or a new worktree —
 * and, optionally, what to say first. The same `POST /v1/agents` the
 * dashboard's dialog and the phone use; the tab opens on success.
 */
import { useMemo, useState } from 'react'
import { api, errText } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { AgentPicker, spawnableAgents, useAgentChoice } from './AgentPicker'
import { DEFAULT_MODE, DEFAULT_MODELS, GEMINI_MAPPED, MODE_NOTE, MODES, ModelField } from './SpawnDialog'
import type { SpawnAgent } from './AgentPicker'
import type { Project } from '@/lib/projects'
import { Sheet, SheetButton, SheetField } from './Sheet'

const NEW_WORKTREE = '__new__'

export function NewAgentSheet({
  projects,
  projectId,
  cwd: initialCwd,
  onClose,
  onStarted,
}: {
  projects: Project[]
  projectId?: string
  /** A worktree's folder, when the sheet was opened from one. */
  cwd?: string
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
  const [where, setWhere] = useState(initialCwd && initialCwd !== project?.root ? initialCwd : '')
  const [newBranch, setNewBranch] = useState('')
  const [models, setModels] = useState<Record<SpawnAgent, string>>(DEFAULT_MODELS)
  const [mode, setMode] = useState(DEFAULT_MODE)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const codexModels = useApi(() => (agent === 'codex' ? api.agentModels('codex') : Promise.resolve(undefined)), [agent], { live: false })

  const start = async () => {
    if (!project) { setError('Pick a project first.'); return }
    if (where === NEW_WORKTREE && !/^[\w./-]+$/.test(newBranch.trim())) { setError('Name the new worktree: letters, digits, dot, dash, slash.'); return }
    setBusy(true)
    setError('')
    try {
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
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      label="New agent"
      title="New agent"
      onClose={onClose}
      footer={
        <>
          {error && <p role="alert" className="mr-auto min-w-0 truncate text-[12px] text-danger" title={error}>{error}</p>}
          <SheetButton onClick={onClose}>Cancel</SheetButton>
          <SheetButton primary disabled={busy || agents.length === 0} onClick={() => void start()}>{busy ? 'Starting…' : 'Start'}</SheetButton>
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
        <div className="grid gap-4 px-5 py-4" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void start() }}>
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
              <input className="input" autoFocus placeholder="feature-x" value={newBranch} onChange={(e) => setNewBranch(e.target.value)} />
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
              {MODES.map(([v, label]) => (
                <option key={v} value={v}>
                  {agent === 'gemini' && !GEMINI_MAPPED.has(v) ? `${label} · Gemini asks instead` : MODE_NOTE[agent]?.[v] ?? label}
                </option>
              ))}
            </select>
          </SheetField>
          <SheetField label="First message" hint="optional · ⌘↩ starts">
            <textarea
              className="input min-h-[84px] resize-y font-[family-name:var(--font-sans)] text-[13px] leading-relaxed"
              autoFocus={where !== NEW_WORKTREE}
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
