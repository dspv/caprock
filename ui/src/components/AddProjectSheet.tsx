/**
 * Add a project (⌘O): an existing folder, a new one (`git init`), or a clone
 * (.ai/03-contracts.md § Projects and shells). Through `POST /v1/projects`;
 * a clone carries an `op_id`, so a retry never clones twice, and the sheet
 * shows git's progress from the `op` frames until the project is listed.
 * Without that endpoint an existing folder is still listed — kept by this
 * app — and the other two say what they need rather than failing quietly.
 */
import { useEffect, useState } from 'react'
import { INSTRUCTIONS_HINT } from './ProjectInstructions'
import { errText } from '@/lib/api'
import { DirPicker } from './DirPicker'
import { RepoPicker } from './RepoPicker'
import { folderName, instructionsPatch, newOpId, NotSupportedError, projectsApi, type AddProjectRequest, type LocalProject, type OpFrame, type ProjectSource } from '@/lib/projects'
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

/** The folder `git clone` would make: the URL's last segment without `.git`. */
export function repoName(url: string): string {
  const tail = url.trim().replace(/[\\/]+$/, '').split(/[/:]/).pop() ?? ''
  return tail.replace(/\.git$/, '')
}

/** Where a clone of `url` lands by default: the default folder plus the repo's name. */
export function cloneDest(url: string, defaultParent: string): string {
  const name = repoName(url)
  return defaultParent && name ? `${defaultParent.replace(/[\\/]+$/, '')}/${name}` : ''
}

/**
 * What to send for each way of adding. A clone's field is the whole
 * destination, as `git clone url dest` takes it — the folder is created, so
 * it must not already exist — and goes to the daemon as parent and name.
 */
export function requestFor(mode: Mode, path: string, url: string, defaultParent: string, opId: string): AddProjectRequest {
  if (mode === 'folder') return { path }
  if (mode === 'new') {
    const { parent, name } = splitPath(path)
    return { create: { parent, name, git_init: true } }
  }
  const { parent, name } = splitPath(path || cloneDest(url, defaultParent))
  return { clone: { url, parent, name }, op_id: opId }
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
  /** `root` and `task` are set when a first task was given: the caller starts an agent on it. */
  onAdded: (projectId: string, first?: { root: string; task: string }) => void
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
  // The project's instructions for its agents, set as it is added (as Orca
  // asks when a project is opened); optional, and editable later where an
  // agent is started.
  const [instructions, setInstructions] = useState('')
  const [showInstructions, setShowInstructions] = useState(false)
  // What the first agent should do. Without it a new project opens on an
  // empty prompt, and a task typed into "instructions" — which only shapes
  // later sessions — started nothing (the owner's report, 2026-10-08).
  const [task, setTask] = useState('')
  // The destination follows the URL until it is edited by hand, the way
  // `git clone` names the folder after the repository.
  const [pathTouched, setPathTouched] = useState(false)
  const editPath = (v: string) => { setPath(v); setPathTouched(true) }
  const editUrl = (v: string) => {
    setUrl(v)
    setError('')
    if (!pathTouched) setPath(cloneDest(v, defaultParent))
  }
  const first = (root: string | undefined) => (task.trim() && root ? { root, task: task.trim() } : undefined)
  const op = cloning ? ops.find((o) => o.op_id === cloning.op_id) ?? cloning : null

  useEffect(() => {
    if (!op || op.state === 'running') return
    if (op.state === 'done' && op.project_id) {
      const id = String(op.project_id)
      void keepInstructions(id).finally(() => { onAdded(id, first(op.dest)); onClose() })
      return
    }
    setBusy(false)
    setCloning(null)
    setOpId(newOpId())
    setError(op.error ? `Clone failed: ${op.error}` : 'Clone failed.')
  }, [op, onAdded, onClose]) // eslint-disable-line react-hooks/exhaustive-deps

  // Best effort: the project is added either way, and the instructions can
  // be set again from the New agent sheet.
  const keepInstructions = async (id: string) => {
    if (!instructions.trim()) return
    try { await projectsApi.patch(id, instructionsPatch(undefined, instructions)) } catch { /* set later */ }
  }

  const submit = async () => {
    setError('')
    const p = path.trim()
    if (mode !== 'clone' && !p) { setError('Choose a folder.'); return }
    if (mode === 'clone' && !isCloneURL(url.trim())) { setError('A clone URL is https://… or git@host:path.'); return }
    if (mode === 'clone' && !p && !cloneDest(url, defaultParent)) { setError('Choose a folder to clone into.'); return }
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
      await keepInstructions(added.project.id)
      onAdded(added.project.id, first(added.project.root))
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
              onClick={() => {
                setMode(m.key); setError(''); setOpId(newOpId())
                // A new project starts in the default folder, with only its name to type.
                if (m.key === 'new' && !path.trim() && defaultParent) setPath(`${defaultParent.replace(/[\\/]+$/, '')}/`)
                if (m.key === 'clone' && !pathTouched) setPath(cloneDest(url, defaultParent))
              }}
              className={`h-[26px] rounded-[6px] px-3 text-[12.5px] ${mode === m.key ? 'bg-panel font-medium text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {mode === 'clone' && <RepoPicker picked={url} onPick={editUrl} />}
        {mode === 'clone' && (
          <SheetField label="Repository URL">
            <input className="input" autoFocus placeholder="https://github.com/you/repo or git@github.com:you/repo.git" value={url} onChange={(e) => editUrl(e.target.value)} />
          </SheetField>
        )}
        <SheetField
          label={mode === 'folder' ? 'Folder' : mode === 'new' ? 'New folder' : 'Clone into'}
          hint={mode === 'new' ? 'created, then git init' : mode === 'clone' ? 'created by the clone · ~ works' : '~ works'}
        >
          <input
            className="input"
            autoFocus={mode !== 'clone'}
            placeholder={mode === 'clone' ? cloneDest('project', defaultParent) || '~/dev/project' : mode === 'new' ? (defaultParent ? `${defaultParent}/new-project` : '~/dev/new-project') : (defaultParent || '~/dev') + '/project'}
            value={path}
            onChange={(e) => editPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          />
          <div className="mt-1.5 min-w-0">
            {/* Picking a folder in clone mode picks where it goes: the
              * repository's own folder is made inside it. */}
            <DirPicker value={path} onPick={(d) => editPath(mode === 'clone' && repoName(url) ? `${d.replace(/[\\/]+$/, '')}/${repoName(url)}` : d)} />
          </div>
        </SheetField>
        {source !== 'derived' && (
          <SheetField label="First task" hint="optional · an agent starts on it once the project is added">
            <textarea
              className="input min-h-[60px] resize-y font-[family-name:var(--font-sans)] text-[13px] leading-relaxed"
              placeholder="Read the repo and tell me what is missing."
              value={task}
              onChange={(e) => setTask(e.target.value)}
            />
          </SheetField>
        )}
        {source !== 'derived' && !showInstructions && (
          <button type="button" onClick={() => setShowInstructions(true)} className="w-fit text-[12.5px] text-fg-muted hover:text-fg">
            + Standing instructions for every agent in this project
          </button>
        )}
        {source !== 'derived' && showInstructions && (
          <SheetField label="Standing instructions" hint={`optional · ${INSTRUCTIONS_HINT}`}>
            <textarea
              autoFocus
              className="input min-h-[72px] resize-y font-[family-name:var(--font-sans)] text-[13px] leading-relaxed"
              placeholder="Use the Makefile, never npm. Commit with Conventional Commits."
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </SheetField>
        )}
        {source === 'derived' && mode !== 'folder' && (
          <p className="text-[12px] leading-relaxed text-fg-faint">This daemon has no projects API yet; creating and cloning arrive with it.</p>
        )}
      </div>
    </Sheet>
  )
}
