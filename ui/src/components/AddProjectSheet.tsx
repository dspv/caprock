/**
 * Add a project (⌘O): an existing folder, a new one (`git init`), or a clone
 * (.ai/21-app.md § Projects, F05). Through `POST /v1/projects` with an
 * `op_id`, so a retry never clones twice. Without that endpoint an existing
 * folder is still listed — kept by this app — and the other two say what
 * they need rather than failing quietly.
 */
import { useState } from 'react'
import { errText } from '@/lib/api'
import { DirPicker } from './DirPicker'
import { folderName, newOpId, NotSupportedError, projectsApi, type LocalProject, type Project, type ProjectSource } from '@/lib/projects'
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

export function AddProjectSheet({
  source,
  onClose,
  onAdded,
  onAddLocal,
}: {
  source: ProjectSource
  onClose: () => void
  onAdded: (p: Project) => void
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

  const submit = async () => {
    setError('')
    const p = path.trim()
    if (mode !== 'clone' && !p) { setError('Choose a folder.'); return }
    if (mode === 'clone' && !isCloneURL(url.trim())) { setError('A clone URL is https://… or git@host:path.'); return }
    setBusy(true)
    try {
      const req = mode === 'clone'
        ? { source: 'clone' as const, url: url.trim(), path: p || undefined, op_id: opId }
        : { source: mode, path: p, op_id: opId }
      const added = await projectsApi.add(req)
      onAdded(added)
      onClose()
    } catch (e) {
      if (e instanceof NotSupportedError && mode === 'folder') {
        onAddLocal({ root: p, name: folderName(p) })
        onClose()
      } else {
        setError(e instanceof NotSupportedError ? `${e.message} An existing folder can be added now.` : errText(e))
      }
    } finally {
      setBusy(false)
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
          hint={mode === 'new' ? 'created, then git init' : mode === 'clone' ? 'optional · beside your other projects by default' : undefined}
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
