/**
 * Add a project (⌘O): an existing folder, a new one (`git init`), or a clone
 * (.ai/03-contracts.md § Projects and shells). Through `POST /v1/projects`;
 * a clone carries an `op_id`, so a retry never clones twice, and the sheet
 * shows git's progress from the `op` frames until the project is listed.
 * Without that endpoint an existing folder is still listed — kept by this
 * app — and the other two say what they need rather than failing quietly.
 *
 * Since 2026-10-09 (owner): the field starts on the default folder
 * (`settings.default_folder`, else `~/`), with *Set as default* beside it;
 * under it, as the path is typed, what will happen there (`GET
 * /v1/browse/stat`, 250 ms after the last key; lib/addproject.ts); Browse is
 * a folder browser; and the keys are on the buttons: ⌘↩ adds, Esc cancels,
 * ⌘1/⌘2/⌘3 the modes, ⌘B Browse ⇄ Recent (Ctrl off macOS).
 */
import { useEffect, useRef, useState } from 'react'
import { INSTRUCTIONS_HINT } from './ProjectInstructions'
import { api, errText, type BrowseStat, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { isMacPlatform } from '@/lib/appmode'
import { defaultFolder, keyLabel, sheetKey, statWorthy, targetNote, withSlash, type SheetKey } from '@/lib/addproject'
import { DirPicker, type PickerTab } from './DirPicker'
import { RepoPicker } from './RepoPicker'
import { folderName, instructionsPatch, newOpId, NotSupportedError, projectsApi, type AddProjectRequest, type LocalProject, type OpFrame, type ProjectSource } from '@/lib/projects'
import { Sheet, SheetButton, SheetField } from './Sheet'

type Mode = 'folder' | 'new' | 'clone'

const MODES: { key: Mode & SheetKey; label: string }[] = [
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
 * destination, as `git clone url dest` takes it — the folder is created, or
 * an empty one used — and goes to the daemon as parent and name.
 */
export function requestFor(mode: Mode, path: string, url: string, defaultParent: string, opId: string): AddProjectRequest {
  if (mode === 'folder') return { path }
  if (mode === 'new') {
    const { parent, name } = splitPath(path)
    return { create: { parent, name, git_init: true } }
  }
  // A folder still open for a name ("~/dev/") is where the repository's own
  // folder goes.
  const dest = !path || /[\\/]$/.test(path) ? cloneDest(url, path || defaultParent) : path
  const { parent, name } = splitPath(dest)
  return { clone: { url, parent, name }, op_id: opId }
}

/** The folder *Set as default* keeps: the field's own folder for an existing
 *  folder, or one typed with a trailing slash; else the folder it goes in. */
export function defaultCandidate(mode: Mode, path: string): string {
  const p = path.trim()
  const typed = p.replace(/[\\/]+$/, '')
  if (!typed) return p ? p.slice(0, 1) : ''
  return mode === 'folder' || /[\\/]$/.test(p) ? typed : splitPath(typed).parent
}

export function AddProjectSheet({
  source,
  defaultParent,
  ops = [],
  onClose,
  onAdded,
  onAddLocal,
}: {
  source: ProjectSource
  /** Where the sheet starts, in place of the default folder setting. */
  defaultParent?: string
  /** Clone progress from the `op` live frames. */
  ops?: readonly OpFrame[]
  onClose: () => void
  /** `root` and `task` are set when a first task was given: the caller starts an agent on it. */
  onAdded: (projectId: string, first?: { root: string; task: string }) => void
  onAddLocal: (p: LocalProject) => void
}) {
  const settings = useApi(() => api.settings(), [], { live: false })
  const [savedDefault, setSavedDefault] = useState<string | undefined>(undefined)
  const base = defaultParent || defaultFolder(savedDefault ?? settings.data?.default_folder)
  const isMac = isMacPlatform()
  const [mode, setMode] = useState<Mode>('folder')
  const [path, setPath] = useState(() => withSlash(base))
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
  const [list, setList] = useState<PickerTab>('recent')
  const [stat, setStat] = useState<BrowseStat | null>(null)
  const field = useRef<HTMLInputElement>(null)
  // The destination follows the URL until it is edited by hand, the way
  // `git clone` names the folder after the repository.
  const [pathTouched, setPathTouched] = useState(false)
  const startPath = (m: Mode, u: string) => (m === 'clone' ? cloneDest(u, base) || withSlash(base) : withSlash(base))
  const editPath = (v: string) => { setPath(v); setPathTouched(true) }
  const editUrl = (v: string) => {
    setUrl(v)
    setError('')
    if (!pathTouched) setPath(startPath('clone', v))
  }
  // The setting arrives after the first render: an untouched field follows it.
  useEffect(() => {
    if (!pathTouched) setPath(startPath(mode, url))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base])
  const first = (root: string | undefined) => (task.trim() && root ? { root, task: task.trim() } : undefined)
  const op = cloning ? ops.find((o) => o.op_id === cloning.op_id) ?? cloning : null

  // What is at the path, asked 250 ms after the last key.
  useEffect(() => {
    setStat(null)
    const p = path.trim()
    if (!statWorthy(mode, p)) return
    let live = true
    const t = setTimeout(() => {
      api.browseStat(p).then((s) => { if (live) setStat(s) }, () => { if (live) setStat(null) })
    }, 250)
    return () => { live = false; clearTimeout(t) }
  }, [mode, path])
  const note = statWorthy(mode, path) ? targetNote(mode, stat) : null

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

  const pickMode = (m: Mode) => {
    setMode(m); setError(''); setOpId(newOpId())
    // Each mode starts in the default folder, with only a name left to type.
    if (!pathTouched) setPath(startPath(m, url))
    field.current?.focus()
  }

  const candidate = defaultCandidate(mode, path)
  const showSetDefault = !!candidate && candidate !== base.replace(/[\\/]+$/, '') && source !== 'derived'
  const setAsDefault = async () => {
    try {
      await api.saveSettings({ default_folder: candidate } as Settings)
      setSavedDefault(candidate)
    } catch (e) {
      setError(errText(e))
    }
  }

  const submit = async () => {
    setError('')
    const p = path.trim()
    if (mode !== 'clone' && !p) { setError('Choose a folder.'); return }
    if (mode === 'clone' && !isCloneURL(url.trim())) { setError('A clone URL is https://… or git@host:path.'); return }
    if (mode === 'clone' && /[\\/]$/.test(p) && !cloneDest(url, base)) { setError('Choose a folder to clone into.'); return }
    if (mode === 'new' && (!splitPath(p).parent || /[\\/]$/.test(p))) { setError('Name the new folder.'); return }
    setBusy(true)
    let keepBusy = false
    try {
      const added = await projectsApi.add(requestFor(mode, p, url.trim(), base, opId))
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

  // The sheet's keys, from anywhere in it; a ref keeps the listener on the
  // latest state.
  const keyRef = useRef<(k: SheetKey) => void>(() => {})
  keyRef.current = (k) => {
    if (k === 'submit') { if (!busy) void submit(); return }
    if (k === 'toggle-list') { setList((t) => (t === 'recent' ? 'browse' : 'recent')); return }
    pickMode(k)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = sheetKey(e, isMac)
      if (!k) return
      e.preventDefault()
      e.stopPropagation()
      keyRef.current(k)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isMac])

  const submitKey = keyLabel('submit', isMac)
  const verb = mode === 'clone' ? 'Clone' : mode === 'new' ? 'Create' : 'Add'
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
          <SheetButton onClick={onClose} aria-keyshortcuts="Escape" title="Cancel (Esc)">
            Cancel
            <kbd aria-hidden="true" className="mono ml-2 text-[11px] font-normal opacity-60">Esc</kbd>
          </SheetButton>
          <SheetButton primary disabled={busy} onClick={() => void submit()} aria-keyshortcuts={isMac ? 'Meta+Enter' : 'Control+Enter'} title={`${verb} (${submitKey})`}>
            {busy ? (mode === 'clone' ? 'Cloning…' : 'Adding…') : verb}
            {!busy && <kbd aria-hidden="true" className="mono ml-2 text-[11px] font-normal opacity-70">{submitKey}</kbd>}
          </SheetButton>
        </>
      }
    >
      <div className="grid gap-4 px-5 py-4">
        <div role="tablist" aria-label="How" className="inline-flex w-fit gap-0.5 rounded-[8px] bg-[var(--app-row-hover)] p-0.5">
          {MODES.map((m, i) => (
            <button
              key={m.key}
              type="button"
              role="tab"
              aria-selected={mode === m.key}
              aria-keyshortcuts={`${isMac ? 'Meta' : 'Control'}+${i + 1}`}
              title={`${m.label} (${keyLabel(m.key, isMac)})`}
              onClick={() => pickMode(m.key)}
              className={`flex h-[26px] items-center gap-1.5 rounded-[6px] px-3 text-[12.5px] ${mode === m.key ? 'bg-panel font-medium text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}
            >
              {m.label}
              <kbd aria-hidden="true" className="mono text-[10.5px] font-normal text-fg-faint">{keyLabel(m.key, isMac)}</kbd>
            </button>
          ))}
        </div>
        {mode === 'clone' && <RepoPicker picked={url} onPick={editUrl} />}
        {mode === 'clone' && (
          <SheetField label="Repository URL">
            <input className="input" placeholder="https://github.com/you/repo or git@github.com:you/repo.git" value={url} onChange={(e) => editUrl(e.target.value)} />
          </SheetField>
        )}
        <div className="grid min-w-0 gap-1.5">
          <SheetField
            label={mode === 'folder' ? 'Folder' : mode === 'new' ? 'New folder' : 'Clone into'}
            hint={mode === 'new' ? 'created, then git init' : mode === 'clone' ? 'created by the clone, or an empty folder · ~ works' : '~ works'}
          >
            <input
              ref={field}
              className="input"
              autoFocus
              spellCheck={false}
              placeholder={mode === 'clone' ? cloneDest('project', base) : `${withSlash(base)}${mode === 'new' ? 'new-project' : 'project'}`}
              value={path}
              onChange={(e) => editPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) void submit() }}
            />
          </SheetField>
          <div className="flex min-h-[18px] min-w-0 items-center gap-2 text-[12px]">
            <span
              role="status"
              aria-label="What is there"
              className={`min-w-0 flex-1 truncate ${note?.tone === 'bad' ? 'text-danger' : note?.tone === 'ok' ? 'text-fg-muted' : 'text-fg-faint'}`}
            >
              {note?.text ?? ''}
            </span>
            {showSetDefault && (
              <button type="button" onClick={() => void setAsDefault()} className="min-w-0 shrink truncate text-fg-faint hover:text-fg" title={`New projects, clones and Browse start in ${candidate}`}>
                Set <span className="mono">{candidate}</span> as default
              </button>
            )}
          </div>
          {/* Picking a folder in clone mode picks where it goes: the
            * repository's own folder is made inside it. Outside the field's
            * label, so a click in the list stays in the list. */}
          <div className="min-w-0">
            <DirPicker
              value={path}
              start={base}
              tab={list}
              onTab={setList}
              onPick={(d) => editPath(mode === 'clone' && repoName(url) ? `${d.replace(/[\\/]+$/, '')}/${repoName(url)}` : mode === 'new' ? withSlash(d) : d)}
            />
            <p className="mt-1 text-[11px] text-fg-faint"><kbd className="mono">{keyLabel('toggle-list', isMac)}</kbd> switches Recent and Browse</p>
          </div>
        </div>
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
