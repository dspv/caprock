/**
 * What a project's agents are told, at a glance and a click away (owner,
 * 2026-10-14, translated: "I want to understand whether this project has a
 * prompt set up — that's important — and by a click see it if I want").
 * Two rows, because two things reach an agent:
 *
 *  - **Caprock's instructions** (`defaults.system_prompt`): appended to the
 *    system prompt of every Claude Code session Caprock starts in the
 *    project (`--append-system-prompt`), and every Codex and Grok session's
 *    developer instructions. "Set · 12 lines" or "None"; Show reads it
 *    whole, Edit (Add when none) changes it in place.
 *  - **The repository's own files** (`CLAUDE.md`, `.claude/CLAUDE.md`,
 *    `AGENTS.md`, a multi-repo project's members' too): read by the agents
 *    themselves, Caprock or not. Show reads them through the project's file
 *    API, one at a time.
 *
 * Shown where an agent is started (New agent) and on the project's page.
 */
import { useEffect, useState } from 'react'
import { errText } from '@/lib/api'
import { instructionsPatch, projectsApi, type Project } from '@/lib/projects'
import { filesApi } from '@/lib/files'
import { instructionsState, repoFilesLabel } from '@/lib/projectWizard'

export const INSTRUCTIONS_HINT = 'given to every Claude Code, Codex and Grok session Caprock starts in this project'

/** The agents Caprock hands its instructions to. */
const TAKES_INSTRUCTIONS = new Set(['claude', 'codex', 'grok'])

export function ProjectInstructions({ project, agent, onSaved }: {
  project: Project
  /** The agent about to start, when there is one: another agent is told it gets none of Caprock's. */
  agent?: string
  onSaved?: (p: Project) => void
}) {
  const saved = project.defaults?.system_prompt ?? ''
  const state = instructionsState(saved)
  const files = project.instruction_files ?? []
  const [editing, setEditing] = useState(false)
  const [showOwn, setShowOwn] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const [text, setText] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const takes = !agent || TAKES_INSTRUCTIONS.has(agent)

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const p = await projectsApi.patch(project.id, instructionsPatch(project.defaults, text))
      onSaved?.(p)
      setEditing(false)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Instructions for agents here" className="grid min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden rounded-[10px] border border-[var(--app-hairline)]">
      <div className="grid min-w-0 gap-1.5 px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <StateDot on={state.set} />
          <span className="text-[13.5px] font-medium text-fg">Project instructions</span>
          <span aria-label="Project instructions state" className={`text-[13.5px] tabular-nums ${state.set ? 'text-fg' : 'text-fg-muted'}`}>{state.label}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {state.set && !editing && (
              <PanelButton label={`${showOwn ? 'Hide' : 'Show'} project instructions`} onClick={() => setShowOwn((v) => !v)} expanded={showOwn}>{showOwn ? 'Hide' : 'Show'}</PanelButton>
            )}
            {!editing && (
              <PanelButton label={`${state.set ? 'Edit' : 'Add'} project instructions`} onClick={() => { setText(saved); setEditing(true); setShowOwn(false) }}>{state.set ? 'Edit' : 'Add'}</PanelButton>
            )}
          </span>
        </div>
        <p className="pl-[18px] text-[12.5px] leading-snug text-fg-muted">
          {takes ? 'Claude Code · Codex · Grok' : 'Not given to this agent: Claude Code, Codex and Grok only'}
          {!state.set && !editing && <span className="text-fg-faint"> — set them once, and every new session here starts with them.</span>}
        </p>
        {state.set && !editing && !showOwn && (
          <p className="line-clamp-2 whitespace-pre-wrap pl-[18px] text-[13px] leading-snug text-fg" title={saved}>{saved}</p>
        )}
        {state.set && !editing && showOwn && (
          <pre aria-label="Project instructions text" className="app-scroll ml-[18px] max-h-[240px] overflow-auto whitespace-pre-wrap rounded-[8px] bg-[var(--app-row-hover)] px-3 py-2 font-[family-name:var(--font-sans)] text-[13px] leading-relaxed text-fg">{saved}</pre>
        )}
        {editing && (
          <div className="grid min-w-0 gap-2 pl-[18px]">
            <textarea
              aria-label="Project instructions"
              className="input min-h-[120px] resize-y leading-relaxed"
              // .input is unlayered and sets mono 12px: prose says so inline.
              style={{ fontFamily: 'var(--font-sans)', fontSize: 13.5, padding: '8px 10px', borderRadius: 7 }}
              autoFocus
              placeholder="Use the Makefile, never npm. Commit with Conventional Commits. Answer in English."
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // ⌘↩ saves here rather than starting the agent.
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); if (!busy) void save() }
              }}
            />
            <div className="flex items-center gap-2">
              {error && <p role="alert" className="mr-auto min-w-0 truncate text-[12px] text-danger" title={error}>{error}</p>}
              <button type="button" onClick={() => setEditing(false)} className="ml-auto h-[30px] rounded-[7px] px-3 text-[13px] text-fg-muted hover:text-fg">Cancel</button>
              <button type="button" disabled={busy} onClick={() => void save()} className="h-[30px] rounded-[7px] bg-accent px-3.5 text-[13px] font-medium text-bg disabled:opacity-50">
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="grid min-w-0 gap-1.5 border-t border-[var(--app-hairline)] px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <StateDot on={files.length > 0} />
          <span className="shrink-0 text-[13.5px] font-medium text-fg">Repository’s own</span>
          <span aria-label="Repository instruction files" className={`mono min-w-0 truncate text-[12.5px] ${files.length ? 'text-fg' : 'text-fg-muted'}`} title={files.join(', ')}>
            {files.length ? repoFilesLabel(files) : 'no CLAUDE.md or AGENTS.md'}
          </span>
          {files.length > 0 && (
            <span className="ml-auto shrink-0">
              <PanelButton label={`${showFiles ? 'Hide' : 'Show'} the repository’s files`} onClick={() => setShowFiles((v) => !v)} expanded={showFiles}>{showFiles ? 'Hide' : 'Show'}</PanelButton>
            </span>
          )}
        </div>
        <p className="pl-[18px] text-[12.5px] leading-snug text-fg-muted">
          {files.length ? 'Read by the agents themselves, whoever starts them' : 'Nothing in the repository itself tells agents what to do'}
        </p>
        {showFiles && files.length > 0 && <RepoFiles projectId={project.id} files={files} />}
      </div>
    </section>
  )
}

function StateDot({ on }: { on: boolean }) {
  return <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${on ? 'bg-ok' : 'border border-[var(--app-hairline-strong)]'}`} />
}

function PanelButton({ label, onClick, expanded, children }: { label: string; onClick: () => void; expanded?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      aria-expanded={expanded}
      className="h-[28px] rounded-[7px] border border-[var(--app-hairline)] px-3 text-[13px] text-fg hover:bg-[var(--app-row-hover)]"
    >
      {children}
    </button>
  )
}

/** The repository's instruction files, one shown at a time, read on demand. */
export function RepoFiles({ projectId, files }: { projectId: string; files: readonly string[] }) {
  const [pick, setPick] = useState(files[0] ?? '')
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!pick) return
    let alive = true
    setText(null)
    setError('')
    filesApi.read({ projectId, worktree: '' }, pick).then(
      (f) => { if (alive) setText(f.binary ? '' : f.text + (f.truncated ? '\n…' : '')) },
      (e) => { if (alive) setError(errText(e)) },
    )
    return () => { alive = false }
  }, [projectId, pick])
  return (
    <div className="grid min-w-0 gap-1.5 pl-[18px]">
      {files.length > 1 && <FileTabs files={files} pick={pick} onPick={setPick} />}
      {error ? (
        <p role="alert" className="text-[12.5px] text-danger">{error}</p>
      ) : (
        <pre aria-label={`${pick} text`} className="app-scroll max-h-[240px] overflow-auto whitespace-pre-wrap rounded-[8px] bg-[var(--app-row-hover)] px-3 py-2 text-[12px] leading-relaxed text-fg">{text ?? 'Reading…'}</pre>
      )}
    </div>
  )
}

export function FileTabs({ files, pick, onPick }: { files: readonly string[]; pick: string; onPick: (f: string) => void }) {
  return (
    <div role="tablist" aria-label="Instruction files" className="flex min-w-0 flex-wrap gap-1">
      {files.map((f) => (
        <button
          key={f}
          type="button"
          role="tab"
          aria-selected={f === pick}
          onClick={() => onPick(f)}
          className={`mono h-[26px] rounded-[6px] px-2 text-[12px] ${f === pick ? 'bg-[var(--app-row-active)] text-fg' : 'text-fg-muted hover:text-fg'}`}
        >
          {f}
        </button>
      ))}
    </div>
  )
}
