/**
 * New project, tap-tap-tap (owner, 2026-10-14, translated: "I still don't
 * understand how to make a multi-repo project, and it matters to me. I want
 * big: quickly click through and the project is created with everything.
 * Or a monorepo, even faster."). Three steps, each one click, in big type:
 *
 *  1. **Folder.** A path field, the places projects already live as chips
 *     (`~/dev`), the folders inside the chosen one as rows — a click on a
 *     row picks it — and, in the desktop app, the system's folder chooser.
 *  2. **What is there.** The folder is scanned (`GET /v1/projects/scan`,
 *     ADR-055) and said in one line: one repository (a single repository or
 *     a monorepo: one project, nothing to choose — a folder inside a
 *     repository is that repository), N repositories as big cards, all
 *     ticked (one project of them, or one each), or a plain folder. On the
 *     same screen, what the agents will be told: the repository's own
 *     CLAUDE.md / AGENTS.md (Show reads it) and, optionally, Caprock's
 *     instructions for every agent here.
 *  3. **Done.** Start an agent there, or close.
 *
 * Enter advances (⌘↩ from the instructions box), Esc closes. Clone and a
 * new empty folder stay in the Add project sheet, one link away.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api, errText } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { isMacPlatform, isTauri } from '@/lib/appmode'
import { shell } from '@/lib/shell'
import { instructionsPatch, projectsApi, type FoundRepo, type InstructionFile, type Project, type ScanResult } from '@/lib/projects'
import { tildePath } from '@/lib/projectSearch'
import { foundNote } from '@/lib/multirepo'
import {
  createLabel, createRequests, drillPath, expandTilde, filterFolders, foundHeadline, foundOf, instructionsState, lastSegment, lineCount, listedAt,
  placeChips, splitTyped, trimSlash,
  type Found, type Shape,
} from '@/lib/projectWizard'
import { Sheet, SheetButton } from './Sheet'
import { FileTabs } from './ProjectInstructions'

type Step = 'folder' | 'found' | 'done'

const BIG_FIELD = { fontSize: 16, padding: '0 14px', borderRadius: 8 } as const
const PROSE_FIELD = { fontFamily: 'var(--font-sans)', fontSize: 14, padding: '10px 12px', borderRadius: 8 } as const

const STEPS: { key: Step; label: string }[] = [
  { key: 'folder', label: 'Folder' },
  { key: 'found', label: 'Project' },
  { key: 'done', label: 'Done' },
]

export function ProjectWizard({
  projects,
  onClose,
  onCreated,
  onStartAgent,
  onMoreWays,
}: {
  projects: readonly Project[]
  onClose: () => void
  /** A project was added (or an existing one opened): select it. */
  onCreated: (projectId: string) => void
  /** Done → Start an agent here: the New agent sheet on this project. */
  onStartAgent: (projectId: string) => void
  /** Clone or a new empty folder: the Add project sheet. */
  onMoreWays?: () => void
}) {
  const isMac = isMacPlatform()
  const settings = useApi(() => api.settings(), [], { live: false })
  const local = useApi(() => api.localRepos(), [], { live: false })
  const recent = useApi(() => api.recentDirs(), [], { live: false })
  const home = local.data?.home
  const defaultFolder = settings.data?.default_folder
  const chips = useMemo(() => placeChips(
    [...projects.map((p) => p.root), ...(recent.data ?? []).map((d) => d.dir), ...(local.data?.repos ?? []).map((r) => r.path)],
    { home, defaultFolder },
  ), [projects, recent.data, local.data, home, defaultFolder])

  const [step, setStep] = useState<Step>('folder')
  const [path, setPath] = useState('')
  const [pathTouched, setPathTouched] = useState(false)
  // The field starts on the first chip, the place projects live most.
  useEffect(() => {
    if (!pathTouched && chips[0]) setPath(chips[0])
  }, [chips, pathTouched])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [found, setFound] = useState<Found | null>(null)
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [shape, setShape] = useState<Shape>('one')
  const [instructions, setInstructions] = useState('')
  const [made, setMade] = useState<{ project: Project; count: number; existed: boolean } | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const startButton = useRef<HTMLButtonElement>(null)

  // The folders inside the one in the field, 250 ms after the last key. A
  // field that names no folder yet (`~/dev/cap`) lists the folder before the
  // name instead (`~/dev/`), kept to the names holding what was typed
  // (owner, 2026-10-15, translated: "typing the first letters should search
  // these folders in this directory"). The match follows every key at once:
  // only a new folder waits for the daemon.
  const [listDir, setListDir] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setListDir(path.trim()), 250)
    return () => clearTimeout(t)
  }, [path])
  const browse = useApi(async () => {
    if (!listDir) return null
    try {
      return { listing: await api.browse(listDir), asked: listDir, filtered: false }
    } catch (e) {
      const { dir, partial } = splitTyped(listDir)
      if (!dir || !partial) throw e
      return { listing: await api.browse(dir), asked: dir, filtered: true }
    }
  }, [listDir], { live: false })
  const typed = splitTyped(path)
  // Filtering while the field still points into the folder listed: typed
  // letters re-filter at once; a field moved elsewhere waits for its listing.
  const filtering = !!browse.data?.filtered && typed.dir === browse.data.asked
  const partial = filtering ? typed.partial : ''
  const matches = useMemo(
    () => (browse.data && !browse.error && (!browse.data.filtered || filtering) ? filterFolders(browse.data.listing.entries, partial) : []),
    [browse.data, browse.error, filtering, partial],
  )
  const shownDir = browse.data ? tildePath(trimSlash(browse.data.listing.dir), home) : ''
  // The highlighted row: the first match while a name is typed, so Enter and
  // Tab take it; none in a plain listing, where Enter looks at the folder in
  // the field, as before. Up and Down move it.
  const [cursor, setCursor] = useState<number | null>(null)
  useEffect(() => { setCursor(null) }, [path])
  const active = matches.length === 0 ? -1 : cursor !== null ? Math.min(cursor, matches.length - 1) : partial ? 0 : -1
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (active < 0) return
    const row = list.current?.querySelector<HTMLElement>(`[data-folder-index="${active}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [active])
  const pickFolder = (p: string) => { setPath(tildePath(p, home)); setPathTouched(true); void look(p) }
  const onFieldKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (matches.length === 0) return
      e.preventDefault()
      const down = e.key === 'ArrowDown'
      setCursor(active < 0 ? (down ? 0 : matches.length - 1) : (active + (down ? 1 : matches.length - 1)) % matches.length)
    } else if (e.key === 'Tab' && !e.shiftKey && active >= 0) {
      e.preventDefault()
      setPath(drillPath(matches[active]!.entry.path, home))
      setPathTouched(true)
      setError('')
    }
  }

  const listed = found ? listedAt(projects, found.kind === 'multi' ? found.root : found.kind === 'one-below' ? found.repo.path : found.path) : undefined

  /** Scan a folder and move to the second step. One repository below the folder is looked at itself. */
  const look = async (folder: string) => {
    const p = folder.trim()
    if (!p) { setError('Choose a folder.'); return }
    setError('')
    setBusy(true)
    try {
      let s = await projectsApi.scan(p)
      let f = foundOf(s)
      if (f.kind === 'one-below') {
        s = await projectsApi.scan(f.repo.path)
        f = foundOf(s)
      }
      setScan(s)
      setFound(f)
      setPicked(new Set(f.kind === 'multi' ? f.repos.filter((r) => !r.member_of).map((r) => r.path) : []))
      setShape('one')
      setStep('found')
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const choose = async () => {
    try {
      const start = expandTilde(trimSlash(path.trim() || '~'), home)
      const dir = await shell.pickFolder(start)
      if (dir) { setPath(tildePath(dir, home)); setPathTouched(true); void look(dir) }
    } catch (e) {
      setError(errText(e))
    }
  }

  const create = async () => {
    if (!found) return
    if (listed) { setMade({ project: listed, count: 1, existed: true }); onCreated(listed.id); setStep('done'); return }
    const order = found.kind === 'multi' ? found.repos.map((r) => r.path).filter((p) => picked.has(p)) : []
    const reqs = createRequests(found, order, shape)
    if (typeof reqs === 'string') { setError(reqs); return }
    setError('')
    setBusy(true)
    try {
      // A project unlisted before comes back with its old name and settings
      // (`created: false`): new to the list all the same.
      const added: Project[] = []
      for (const req of reqs) {
        const res = await projectsApi.add(req)
        if ('project' in res) added.push(res.project)
      }
      if (added.length === 0) throw new Error('The daemon answered without a project.')
      if (instructions.trim()) {
        // Every project made here gets them: "every agent here". The
        // first one's failure is said; the others' can be set later.
        for (let i = 0; i < added.length; i++) {
          const p = added[i]!
          try {
            added[i] = await projectsApi.patch(p.id, instructionsPatch(p.defaults, instructions))
          } catch (e) {
            if (i === 0) throw e
          }
        }
      }
      const first = added[0]!
      setMade({ project: first, count: added.length, existed: false })
      onCreated(first.id)
      setStep('done')
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (step === 'done') startButton.current?.focus()
    if (step === 'folder') field.current?.focus()
  }, [step])

  // Enter advances from anywhere but a text box (⌘↩ there) or a button (it
  // presses the button). A ref keeps the listener on the latest state.
  const advanceRef = useRef<() => void>(() => {})
  advanceRef.current = () => {
    if (busy) return
    if (step === 'folder') {
      const hit = matches[active]
      if (hit) pickFolder(hit.entry.path)
      else void look(path)
    }
    else if (step === 'found') void create()
    else if (made) { onStartAgent(made.project.id) }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const mod = e.metaKey || e.ctrlKey
      if (t instanceof HTMLTextAreaElement && !mod) return
      if (t instanceof HTMLButtonElement && !mod) return
      if (t instanceof HTMLAnchorElement) return
      e.preventDefault()
      e.stopPropagation()
      advanceRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const enter = '↩'
  const modEnter = isMac ? '⌘↩' : 'Ctrl+↵'
  const pickedCount = picked.size
  const primary = step === 'folder'
    ? { label: busy ? 'Looking…' : 'Continue', run: () => void look(path) }
    : step === 'found' && found
      ? { label: busy ? 'Creating…' : createLabel(found, pickedCount, shape, !!listed), run: () => void create() }
      : null

  return (
    <Sheet
      label="New project"
      title={<StepsTitle step={step} />}
      onClose={onClose}
      width={680}
      footer={step === 'done' ? undefined : (
        <>
          {error ? (
            <p role="alert" className="mr-auto min-w-0 truncate text-[13px] text-danger" title={error}>{error}</p>
          ) : step === 'folder' && onMoreWays ? (
            <button type="button" onClick={onMoreWays} className="mr-auto text-[13px] text-fg-muted hover:text-fg">Clone, or start an empty folder…</button>
          ) : step === 'found' ? (
            <button type="button" onClick={() => { setStep('folder'); setError('') }} className="mr-auto text-[13px] text-fg-muted hover:text-fg">← Another folder</button>
          ) : <span className="mr-auto" />}
          <SheetButton onClick={onClose} aria-keyshortcuts="Escape" title="Cancel (Esc)" keyHint="Esc">Cancel</SheetButton>
          {primary && (
            <SheetButton primary disabled={busy} onClick={primary.run} aria-keyshortcuts="Enter" title={`${primary.label} (${enter})`} keyHint={busy ? undefined : enter}>
              {primary.label}
            </SheetButton>
          )}
        </>
      )}
    >
      {step === 'folder' && (
        <div className="grid gap-5 px-6 py-6">
          <div className="grid gap-1">
            <h3 className="text-[22px] font-semibold leading-tight tracking-[-0.015em] text-fg">Where is it?</h3>
            <p className="text-[14px] text-fg-muted">A repository, a monorepo, or a folder that holds several repositories.</p>
          </div>
          <div className="flex min-w-0 gap-2">
            <input
              ref={field}
              aria-label="Folder"
              className="input h-[46px] min-w-0 flex-1"
              // .input is unlayered and sets 12px: the big field says so inline.
              style={BIG_FIELD}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              placeholder="~/dev/project"
              value={path}
              role="combobox"
              aria-expanded={matches.length > 0}
              aria-controls="wizard-folders"
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? `wizard-folder-${active}` : undefined}
              onChange={(e) => { setPath(e.target.value); setPathTouched(true); setError('') }}
              onKeyDown={onFieldKey}
            />
            {isTauri() && (
              <button type="button" onClick={() => void choose()} className="h-[46px] shrink-0 rounded-[8px] border border-[var(--app-hairline-strong)] px-4 text-[14px] text-fg hover:bg-[var(--app-row-hover)]">
                Choose…
              </button>
            )}
          </div>
          {chips.length > 0 && (
            <div role="group" aria-label="Places" className="flex min-w-0 flex-wrap gap-2">
              {chips.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={trimSlash(path.trim()) === c}
                  onClick={() => { setPath(c); setPathTouched(true); setError(''); field.current?.focus() }}
                  className={`mono h-[34px] rounded-full border px-3.5 text-[13.5px] ${trimSlash(path.trim()) === c ? 'border-[var(--app-hairline-strong)] bg-[var(--app-row-active)] text-fg' : 'border-[var(--app-hairline)] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'}`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          {matches.length > 0 && (
            <div className="grid min-w-0 gap-1.5">
              <p className="text-[12.5px] text-fg-muted">
                {partial
                  ? <>In <span className="mono">{shownDir}</span>, names with <span className="mono text-fg">{partial}</span> — ↑↓ moves, Tab goes inside, {enter} picks</>
                  : <>Inside <span className="mono">{shownDir}</span> — a click picks one</>}
              </p>
              <ul ref={list} id="wizard-folders" role="listbox" aria-label="Folders" className="app-scroll grid max-h-[300px] grid-cols-[minmax(0,1fr)] gap-px overflow-y-auto rounded-[10px] border border-[var(--app-hairline)] bg-[var(--app-hairline)]">
                {matches.map(({ entry: e, start, length }, i) => (
                  <li key={e.path} role="presentation" className={`flex min-w-0 ${i === active ? 'bg-[var(--app-row-active)]' : 'bg-panel'}`}>
                    <button
                      type="button"
                      id={`wizard-folder-${i}`}
                      role="option"
                      aria-selected={i === active}
                      data-folder-index={i}
                      tabIndex={-1}
                      onClick={() => pickFolder(e.path)}
                      onMouseMove={() => { if (partial && cursor !== i) setCursor(i) }}
                      className="app-row flex h-[44px] min-w-0 flex-1 items-center gap-3 px-4 text-left"
                      title={`Make ${e.name} a project`}
                    >
                      <span className="mono min-w-0 flex-1 truncate text-[14px] text-fg">
                        {length > 0 ? (
                          <>
                            {e.name.slice(0, start)}
                            <mark data-match className="rounded-[3px] bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] font-semibold text-fg">{e.name.slice(start, start + length)}</mark>
                            {e.name.slice(start + length)}
                          </>
                        ) : e.name}
                      </span>
                      {e.repo && <span className="shrink-0 text-[12px] text-fg-muted">git</span>}
                    </button>
                    {!e.repo && (
                      <button
                        type="button"
                        aria-label={`Look inside ${e.name}`}
                        title="Look inside (Tab)"
                        tabIndex={-1}
                        onClick={() => { setPath(drillPath(e.path, home)); setPathTouched(true); field.current?.focus() }}
                        className="app-row flex h-[44px] w-[44px] shrink-0 items-center justify-center text-[16px] text-fg-muted"
                      >
                        ›
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {filtering && partial && matches.length === 0 && (
            <p role="status" className="text-[13px] text-fg-muted">
              No folder starting with ‘<span className="mono text-fg">{partial}</span>’ in <span className="mono">{shownDir}</span>
            </p>
          )}
        </div>
      )}
      {step === 'found' && found && scan && (
        <FoundStep
          found={found}
          scan={scan}
          home={home}
          listed={listed}
          picked={picked}
          onPicked={(n) => { setPicked(n); setError('') }}
          shape={shape}
          onShape={setShape}
          instructions={instructions}
          onInstructions={setInstructions}
          modEnter={modEnter}
        />
      )}
      {step === 'done' && made && (
        <div className="grid gap-6 px-6 py-7">
          <div className="grid gap-1.5">
            <h3 className="text-[24px] font-semibold leading-tight tracking-[-0.015em] text-fg">
              <span aria-hidden="true" className="mr-2 text-ok">✓</span>
              {made.count > 1 ? `${made.count} projects are ready` : made.existed ? `${made.project.name} is already a project` : `${made.project.name} is ready`}
            </h3>
            <p className="mono truncate text-[13px] text-fg-muted">{made.project.root}</p>
            <p className="text-[14px] text-fg-muted">
              {made.project.repos?.length ? `${made.project.repos.length} repositories · ` : ''}
              Instructions: {instructionsState(made.project.defaults?.system_prompt).set ? instructionsState(made.project.defaults?.system_prompt).label.toLowerCase() : 'none from Caprock'}
              {(scan?.instruction_files?.length ?? 0) > 0 ? ` · repo has ${scan!.instruction_files!.map((f) => f.name).join(', ')}` : ''}
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              ref={startButton}
              type="button"
              onClick={() => onStartAgent(made.project.id)}
              className="flex h-[52px] items-center justify-center gap-2 rounded-[10px] bg-accent px-4 text-[15px] font-medium text-bg hover:opacity-90"
            >
              Start an agent here <kbd aria-hidden="true" className="mono text-[13px] opacity-75">{enter}</kbd>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-[52px] items-center justify-center gap-2 rounded-[10px] border border-[var(--app-hairline-strong)] px-4 text-[15px] text-fg hover:bg-[var(--app-row-hover)]"
            >
              Just add <kbd aria-hidden="true" className="mono text-[13px] text-fg-muted">Esc</kbd>
            </button>
          </div>
        </div>
      )}
    </Sheet>
  )
}

function StepsTitle({ step }: { step: Step }) {
  const at = STEPS.findIndex((s) => s.key === step)
  return (
    <span className="flex items-center gap-3">
      <span>New project</span>
      <ol aria-label="Steps" className="flex items-center gap-1.5 text-[12.5px] font-normal">
        {STEPS.map((s, i) => (
          <li key={s.key} aria-current={i === at ? 'step' : undefined} className={`flex items-center gap-1.5 ${i === at ? 'text-fg' : i < at ? 'text-fg-muted' : 'text-fg-faint'}`}>
            {i > 0 && <span aria-hidden="true" className="text-fg-faint">·</span>}
            <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-full text-[11px] tabular-nums ${i === at ? 'bg-[var(--app-row-active)] text-fg' : ''}`}>{i < at ? '✓' : i + 1}</span>
            {s.label}
          </li>
        ))}
      </ol>
    </span>
  )
}

function FoundStep({
  found, scan, home, listed, picked, onPicked, shape, onShape, instructions, onInstructions, modEnter,
}: {
  found: Found
  scan: ScanResult
  home?: string
  listed?: Project
  picked: ReadonlySet<string>
  onPicked: (n: Set<string>) => void
  shape: Shape
  onShape: (s: Shape) => void
  instructions: string
  onInstructions: (v: string) => void
  modEnter: string
}) {
  const toggle = (p: string) => {
    const next = new Set(picked)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    onPicked(next)
  }
  const where = found.kind === 'multi' ? found.root : found.kind === 'one-below' ? found.repo.path : found.path
  const sub = found.kind === 'repo'
    ? found.inside
      ? <>The folder is inside the repository <span className="mono text-fg">{found.name}</span>: the project is that repository.</>
      : <>A single repository or a monorepo: one project. Agents start in it.</>
    : found.kind === 'folder'
      ? <>No git repository here. It becomes a project all the same.</>
      : found.kind === 'multi'
        ? shape === 'one'
          ? <>One project of them. Agents start in <span className="mono text-fg">{tildePath(found.root, home)}</span> and reach every repository.</>
          : <>One project for each repository picked, as if each were added alone.</>
        : null
  const memberFiles = found.kind === 'multi' ? found.repos.filter((r) => (r.instruction_files?.length ?? 0) > 0) : []
  return (
    <div className="grid gap-5 px-6 py-6">
      <div className="grid gap-1.5">
        <h3 aria-label="What is there" className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-fg">{foundHeadline(found, picked.size)}</h3>
        <p className="mono truncate text-[13px] text-fg-muted" title={where}>{tildePath(where, home)}</p>
        <p className="text-[14.5px] leading-snug text-fg-muted">{sub}</p>
        {listed && <p className="text-[14px] text-fg">Already a project, <span className="font-medium">{listed.name}</span>: nothing is added twice.</p>}
      </div>
      {found.kind === 'multi' && (
        <div className="grid min-w-0 gap-2.5">
          <ul aria-label="Repositories" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {found.repos.map((r) => <RepoCard key={r.path} repo={r} checked={picked.has(r.path)} onToggle={() => toggle(r.path)} />)}
          </ul>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
            <button type="button" onClick={() => onPicked(new Set(found.repos.map((r) => r.path)))} className="text-fg-muted hover:text-fg">All</button>
            <button type="button" onClick={() => onPicked(new Set())} className="text-fg-muted hover:text-fg">None</button>
            {picked.size >= 2 && (
              <button type="button" onClick={() => onShape(shape === 'one' ? 'separate' : 'one')} className="ml-auto text-fg-muted hover:text-fg">
                {shape === 'one' ? `Or add them as ${picked.size} separate projects` : 'Or one project of them all'}
              </button>
            )}
          </div>
        </div>
      )}
      <AgentsTold files={scan.instruction_files ?? []} memberFiles={memberFiles} />
      {!listed && (
        <label className="grid min-w-0 gap-1.5">
          <span className="flex items-baseline gap-2 text-[14px] font-medium text-fg">
            Instructions for every agent here
            <span className="text-[12.5px] font-normal text-fg-muted">optional · Claude Code · Codex · Grok</span>
          </span>
          <textarea
            className="input min-h-[78px] resize-y leading-relaxed"
            style={PROSE_FIELD}
            placeholder="Use the Makefile, never npm. Commit with Conventional Commits."
            value={instructions}
            onChange={(e) => onInstructions(e.target.value)}
          />
          <span className="text-[12px] text-fg-faint">Skip it, or set it later where an agent is started · {modEnter} creates from here</span>
        </label>
      )}
    </div>
  )
}

function RepoCard({ repo, checked, onToggle }: { repo: FoundRepo; checked: boolean; onToggle: () => void }) {
  const note = foundNote(repo)
  return (
    <li className="min-w-0">
      <label
        className={`flex min-h-[56px] cursor-pointer items-center gap-3 rounded-[10px] border px-3.5 py-2.5 ${checked ? 'border-[var(--app-hairline-strong)] bg-[var(--app-row-hover)]' : 'border-[var(--app-hairline)] opacity-70 hover:opacity-100'}`}
        title={repo.path}
      >
        <input type="checkbox" className="h-[18px] w-[18px] shrink-0" checked={checked} onChange={onToggle} aria-label={repo.name} />
        <span className="grid min-w-0 gap-0.5">
          <span className="mono truncate text-[15px] text-fg">{repo.name}</span>
          {(note || (repo.instruction_files?.length ?? 0) > 0) && (
            <span className="truncate text-[12px] text-fg-muted">
              {[note, ...(repo.instruction_files ?? [])].filter(Boolean).join(' · ')}
            </span>
          )}
        </span>
      </label>
    </li>
  )
}

/** What the agents will read on their own: the folder's (or repository's) files, shown on a click; members' named. */
function AgentsTold({ files, memberFiles }: { files: readonly InstructionFile[]; memberFiles: readonly FoundRepo[] }) {
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState(files[0]?.name ?? '')
  if (files.length === 0 && memberFiles.length === 0) return null
  const shown = files.find((f) => f.name === pick) ?? files[0]
  return (
    <section aria-label="Already tells agents" className="grid min-w-0 gap-2 rounded-[10px] border border-[var(--app-hairline)] px-4 py-3">
      {files.length > 0 && (
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-ok" />
          <span className="min-w-0 flex-1 text-[14px] text-fg">
            Already has <span className="mono">{files.map((f) => f.name).join(', ')}</span> — agents read it
          </span>
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="h-[30px] shrink-0 rounded-[7px] border border-[var(--app-hairline)] px-3 text-[13px] text-fg hover:bg-[var(--app-row-hover)]">
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
      )}
      {open && shown && (
        <div className="grid min-w-0 gap-1.5">
          {files.length > 1 && <FileTabs files={files.map((f) => f.name)} pick={shown.name} onPick={setPick} />}
          <pre aria-label={`${shown.name} text`} className="app-scroll max-h-[220px] overflow-auto whitespace-pre-wrap rounded-[8px] bg-[var(--app-row-hover)] px-3 py-2 text-[12px] leading-relaxed text-fg">
            {shown.text}{shown.truncated ? '\n…' : ''}
          </pre>
          <p className="text-[12px] text-fg-faint">{lineCount(shown.text)} lines</p>
        </div>
      )}
      {memberFiles.length > 0 && (
        <p className="flex min-w-0 items-center gap-2.5 text-[13.5px] text-fg-muted">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-ok" />
          <span className="min-w-0 truncate">
            {memberFiles.length === 1 ? lastSegment(memberFiles[0]!.name) : `${memberFiles.length} repositories`} {memberFiles.length === 1 ? 'has' : 'have'} their own instructions: {memberFiles.map((r) => `${r.name} (${r.instruction_files!.join(', ')})`).join(', ')}
          </span>
        </p>
      )}
    </section>
  )
}
