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
 * cancels. The keys are named in the footer and on Start itself.
 *
 * Where is worded for someone who has never heard of a git worktree (owner,
 * 2026-10-09: "existing or new — totally unclear"): *This folder* is the
 * project's own checkout, *Existing copy* a worktree already there, *New copy
 * on its own branch* a new one, explained in a line under the name field.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errText } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { AgentPicker, spawnableAgents, useAgentChoice } from './AgentPicker'
import { DEFAULT_MODE, DEFAULT_MODELS, GEMINI_MAPPED, ModelField, modeNotes, modeOptions } from './SpawnDialog'
import { useInitialMode } from '@/lib/permissionMode'
import type { SpawnAgent } from './AgentPicker'
import type { Project } from '@/lib/projects'
import { ProjectInstructions } from './ProjectInstructions'
import { Sheet, SheetButton, SheetField } from './Sheet'
import { stepSelect } from '@/lib/selectKeys'
import { BypassConsentNote, useBypassConsent } from './BypassConsent'
import { defaultWorktreeName, WORKTREE_NAME } from '@/lib/slug'
import { isMacPlatform } from '@/lib/appmode'

const NEW_WORKTREE = '__new__'

/** What the Where select says of a worktree, for a tooltip: the plain words
 *  in the options are "copy", and this is where the git term lives. */
export const WHERE_TOOLTIP = 'A copy is a git worktree: a second folder of the same repository, checked out on its own branch.'

/** The last segment of a path, either separator. */
function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

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
  const [mode, setMode, rememberMode] = useInitialMode(DEFAULT_MODE)
  const [prompt, setPrompt] = useState(initialPrompt)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const consent = useBypassConsent(agent, mode)
  // The name is optional: left empty, it comes from the first message.
  const worktreeName = newBranch.trim() || defaultWorktreeName(prompt)
  const nameBad = !!newBranch.trim() && !WORKTREE_NAME.test(newBranch.trim())
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
    if (where === NEW_WORKTREE && nameBad) return
    setBusy(true)
    setError('')
    try {
      if (consent.needed) await consent.accept()
      const req: Parameters<typeof api.spawn>[0] = { cwd: where && where !== NEW_WORKTREE ? where : project.root }
      if (agent !== 'claude') req.agent = agent
      if (models[agent]?.trim()) req.model = models[agent].trim()
      if (mode) req.permission_mode = mode
      if (where === NEW_WORKTREE) req.worktree = worktreeName
      if (prompt.trim()) req.prompt = prompt.trim()
      const { session_id } = await api.spawn(req)
      rememberMode()
      onStarted(session_id, project.id, prompt.trim().slice(0, 60) || 'new session')
      onClose()
    } catch (e) {
      if (!consent.noteRefusal(e)) setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  startRef.current = () => { if (!busy && agents.length > 0) void start() }
  const startKey = isMacPlatform() ? '⌘↩' : 'Ctrl+↵'

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
              <p className="mr-auto min-w-0 truncate text-[11.5px] text-fg-faint" aria-label={`Keys: Tab moves, arrows change a choice, ${isMacPlatform() ? 'Command' : 'Control'} Enter starts, Escape cancels`}>
                <span className="mono">Tab</span> moves · <span className="mono">↑↓</span> change · <span className="mono">{startKey}</span> starts · <span className="mono">Esc</span> cancels
              </p>
            )}
          <SheetButton onClick={onClose}>Cancel</SheetButton>
          <SheetButton
            primary
            disabled={busy || agents.length === 0}
            onClick={() => void start()}
            aria-keyshortcuts={isMacPlatform() ? 'Meta+Enter' : 'Control+Enter'}
            title={`Start (${startKey})`}
          >
            {busy ? 'Starting…' : consent.needed ? 'Accept and start' : 'Start'}
            {/* The key on the button it presses (owner, 2026-10-09: "the button
              * is there but the shortcut is unclear"). Hidden from the
              * accessible name, which aria-keyshortcuts carries instead. */}
            {!busy && <kbd aria-hidden="true" className="mono ml-2 text-[11px] font-normal opacity-70">{startKey}</kbd>}
          </SheetButton>
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
              <select className="input" title={WHERE_TOOLTIP} value={where} onChange={(e) => setWhere(e.target.value)}>
                <option value="">{project?.branch ? `This folder · ${project.branch}` : 'This folder'}</option>
                {worktrees.map((w) => <option key={w.path} value={w.path}>Existing copy · {w.branch || w.name}</option>)}
                {initialCwd && initialCwd !== project?.root && !worktrees.some((w) => w.path === initialCwd) && <option value={initialCwd}>Existing copy · {baseName(initialCwd)}</option>}
                <option value={NEW_WORKTREE}>New copy on its own branch</option>
              </select>
            </SheetField>
          </div>
          {where === NEW_WORKTREE && (
            <div className="grid min-w-0 gap-1.5">
              <SheetField
                label="Branch name"
                hint={nameBad ? <span className="text-danger">letters, digits, dot and dash only</span> : 'optional'}
              >
                <input className="input" aria-invalid={nameBad || undefined} placeholder={worktreeName} value={newBranch} onChange={(e) => setNewBranch(e.target.value)} spellCheck={false} />
              </SheetField>
              <p className="text-[12px] leading-snug text-fg-faint" title={WHERE_TOOLTIP}>
                A separate folder with its own branch, so this agent doesn’t collide with others. Branch: <span className="mono text-fg-muted">caprock/{worktreeName}</span>
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            {agents.length > 1 ? <AgentPicker value={agent} agents={agents} onChange={setAgent} /> : <div />}
            <SheetField label="Model">
              <ModelField agent={agent} value={models[agent]} onChange={(v) => setModels((m) => ({ ...m, [agent]: v }))} codex={codexModels.data} />
            </SheetField>
          </div>
          <SheetField label="Permissions" hint="kept for the next agent">
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
              {modeOptions(mode).map(([v, label]) => (
                <option key={v} value={v}>
                  {agent === 'gemini' && !GEMINI_MAPPED.has(v) ? `${label} · Gemini asks instead` : modeNotes(agent, status.data?.opencode_version)?.[v] ?? label}
                </option>
              ))}
            </select>
          </SheetField>
          {consent.needed && <BypassConsentNote />}
          {project && (agent === 'claude' || agent === 'codex') && <ProjectInstructions key={project.id} project={project} />}
          <SheetField label="First message" hint="optional">
            <textarea
              className="input min-h-[84px] resize-y font-[family-name:var(--font-sans)] text-[13px] leading-relaxed"
              autoFocus
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
