/**
 * A project's instructions for its agents: what every Claude Code session
 * started in the project gets appended to its system prompt
 * (`defaults.system_prompt`, `--append-system-prompt`). Shown where an agent
 * is started, so what goes into the session is in sight, and editable there.
 */
import { useState } from 'react'
import { errText } from '@/lib/api'
import { instructionsPatch, projectsApi, type Project } from '@/lib/projects'

export const INSTRUCTIONS_HINT = 'added to the system prompt of every Claude Code session in this project'

export function ProjectInstructions({ project, onSaved }: { project: Project; onSaved?: (p: Project) => void }) {
  const saved = project.defaults?.system_prompt ?? ''
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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

  if (!editing) {
    return (
      <div className="grid min-w-0 gap-1.5">
        <span className="flex items-baseline gap-2 text-[12px] font-medium text-fg-muted">
          Project instructions
          <span className="font-normal text-fg-faint">Claude Code</span>
          <button type="button" onClick={() => { setText(saved); setEditing(true) }} className="ml-auto text-[12px] font-normal text-accent hover:underline">
            {saved ? 'Edit' : 'Add'}
          </button>
        </span>
        {saved ? (
          <p className="line-clamp-2 whitespace-pre-wrap text-[12.5px] leading-snug text-fg" title={saved}>{saved}</p>
        ) : (
          <p className="text-[12.5px] text-fg-faint">None — set them once, and every new session here starts with them.</p>
        )}
      </div>
    )
  }
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="flex items-baseline gap-2 text-[12px] font-medium text-fg-muted">
        Project instructions <span className="font-normal text-fg-faint">{INSTRUCTIONS_HINT}</span>
      </span>
      <textarea
        aria-label="Project instructions"
        className="input min-h-[96px] resize-y font-[family-name:var(--font-sans)] text-[13px] leading-relaxed"
        autoFocus
        placeholder="Use the Makefile, never npm. Commit with Conventional Commits. Answer in English."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-2">
        {error && <p role="alert" className="mr-auto min-w-0 truncate text-[12px] text-danger" title={error}>{error}</p>}
        <button type="button" onClick={() => setEditing(false)} className="ml-auto h-[26px] rounded-[6px] px-3 text-[12.5px] text-fg-muted hover:text-fg">Cancel</button>
        <button type="button" disabled={busy} onClick={() => void save()} className="h-[26px] rounded-[6px] bg-accent px-3 text-[12.5px] font-medium text-bg disabled:opacity-50">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
