/**
 * Add a project (⌘O): an existing folder, a new one (`git init`), or a clone
 * (.ai/03-contracts.md § Projects and shells). Through `POST /v1/projects`;
 * a clone carries an `op_id`, so a retry never clones twice, and the sheet
 * shows git's progress from the `op` frames until the project is listed.
 * Without that endpoint an existing folder is still listed — kept by this
 * app — and the other two say what they need rather than failing quietly.
 */
import { useEffect, useState } from 'react'
import { errText } from '@/lib/api'
import { DirPicker } from './DirPicker'
import { folderName, newOpId, NotSupportedError, projectsApi, type AddProjectRequest, type LocalProject, type OpFrame, type ProjectSource } from '@/lib/projects'
import { Sheet, SheetButton, SheetField } from './Sheet'

type Mode = 'folder' | 'new' | 'clone'

const MODES: { key: Mode; label: string }[] = [
  { key: 'folder', label: 'Existing folder' },
  { key: 'new', label: 'New project' },
  { key: 'clone', label: 'Clone' },
]

/** Clone URLs the daemon will run: https, or git@host:path (.ai/21-app.md § Projects). */
export function isCloneURL(url: string): boolean {
  return /^https:\/\/[^\s/]+\/\S+$/.test(url) || /^git@[\w.-]+:[\w./-]+$/.test(url)
}

/** A path split into its parent folder and last segment. */
export function splitPath(path: string): { parent: string; name: string } {
  const p = path.replace(/[\\/]+$/, '')
  const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return at <= 0 ? { parent: at === 0 ? p.slice(0, 1) : '', name: p.slice(at + 1) } : { parent: p.slice(0, at), name: p.slice(at + 1) }
}

/** What to send for each way of adding. */
function requestFor(mode: Mode, path: string, url: string, defaultParent: string, opId: string): AddProjectRequest {
  if (mode === 'folder') return { path }
  if (mode === 'new') {
    const { parent, name } = splitPath(path)
    return { create: { parent, name, git_init: true } }
  }
  return { clone: { url, parent: path || defaultParent }, op_id: opId }
}

export function AddProjectSheet({
  source,
  defaultParent = '',
  ops = [],
  onClose,
  onAdded,
  onAddLocal,
}: {
  source: ProjectSource
  /** Where a clone goes when no folder is named: beside the current project. */
  defaultParent?: string
  /** Clone progress from the `op` live frames. */
  ops?: readonly OpFrame[]
  onClose: () => void
  onAdded: (projectId: string) => void
  onAddLocal: (p: LocalProject) => void
}) {
  const [mode, setMode] = useState<Mode>('folder')
  const [path, setPath] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // One id per attempt at the same thing: a retry after a dropped answer is
  // the same operation, and the daemon returns the first instead of cloning twice.
  const [opId, setOpId] = useState(newOpId)
  const [cloning, setCloning] = useState<OpFrame | null>(null)
  const op = cloning ? ops.find((o) => o.op_id === cloning.op_id) ?? cloning : null

  useEffect(() => {
    if (!op || op.state === 'running') return
    if (op.state === 'done' && op.project_id) {
      onAdded(String(op.project_id))
      onClose()
      return
    }
    setBusy(false)
    setCloning(null)
    setOpId(newOpId())
    setError(op.error ? `Clone failed: ${op.error}` : 'Clone failed.')
  }, [op, onAdded, onClose])

  const submit = async () => {
    setError('')
    const p = path.trim()
    if (mode !== 'clone' && !p) { setError('Choose a folder.'); return }
    if (mode === 'clone' && !isCloneURL(url.trim())) { setError('A clone URL is https://… or git@host:path.'); return }
    if (mode === 'clone' && !p && !defaultParent) { setError('Choose a folder to clone into.'); return }
    if (mode === 'new' && !splitPath(p).parent) { setError('Name the new folder with its full path.'); return }
    setBusy(true)
    let keepBusy = false
    try {
      const added = await projectsApi.add(requestFor(mode, p, url.trim(), defaultParent, opId))
      if ('op' in added) {
        // The clone runs in the daemon; its frames say when it is listed.
        keepBusy = true
        setCloning(added.op)
        return
      }
      onAdded(added.project.id)
      onClose()
    } catch (e) {
      if (e instanceof NotSupportedError && mode === 'folder') {
        onAddLocal({ root: p, name: folderName(p) })
        onClose()
      } else {
        setError(e instanceof NotSupportedError ? `${e.message} An existing folder can be added now.` : errText(e))
      }
    } finally {
      if (!keepBusy) setBusy(false)
    }
  }

  return (
    <Sheet
      label="Add a project"
      title="Add a project"
      onClose={onClose}
      footer={
        <>
          {error && <p role="alert" className="mr-auto min-w-0 truncate text-[12px] text-danger" title={error}>{error}</p>}
          {!error && op && (
            <p role="status" className="mr-auto min-w-0 truncate text-[12px] tabular-nums text-fg-muted">
              {op.phase ? `${op.phase} ${op.progress ?? 0}%` : 'Starting the clone…'}
            </p>
          )}
          <SheetButton onClick={onClose}>Cancel</SheetButton>
          <SheetButton primary disabled={busy} onClick={() => void submit()}>
            {busy ? (mode === 'clone' ? 'Cloning…' : 'Adding…') : mode === 'clone' ? 'Clone' : mode === 'new' ? 'Create' : 'Add'}
          </SheetButton>
        </>
      }
    >
      <div className="grid gap-4 px-5 py-4">
        <div role="tablist" aria-label="How" className="inline-flex w-fit gap-0.5 rounded-[8px] bg-[var(--app-row-hover)] p-0.5">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              role="tab"
              aria-selected={mode === m.key}
              onClick={() => { setMode(m.key); setError(''); setOpId(newOpId()) }}
              className={`h-[26px] rounded-[6px] px-3 text-[12.5px] ${mode === m.key ? 'bg-panel font-medium text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {mode === 'clone' && (
          <SheetField label="Repository URL">
            <input className="input" autoFocus placeholder="https://github.com/you/repo or git@github.com:you/repo.git" value={url} onChange={(e) => setUrl(e.target.value)} />
          </SheetField>
        )}
        <SheetField
          label={mode === 'folder' ? 'Folder' : mode === 'new' ? 'New folder' : 'Clone into'}
          hint={mode === 'new' ? 'created, then git init' : mode === 'clone' ? (defaultParent ? `optional · ${defaultParent} by default` : 'the folder the clone goes in') : undefined}
        >
          <input className="input" autoFocus={mode !== 'clone'} placeholder={mode === 'new' ? '/Users/you/dev/new-project' : '/Users/you/dev/project'} value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} />
          <div className="mt-1.5 min-w-0">
            <DirPicker value={path} onPick={setPath} />
          </div>
        </SheetField>
        {source === 'derived' && mode !== 'folder' && (
          <p className="text-[12px] leading-relaxed text-fg-faint">This daemon has no projects API yet; creating and cloning arrive with it.</p>
        )}
      </div>
    </Sheet>
  )
}
