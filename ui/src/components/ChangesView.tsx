/**
 * The Changes view of one worktree, in the app workspace: what is staged,
 * what is not, each file's diff (unified or side by side), and committing,
 * pushing and pulling it without a terminal (.ai/04-ui.md § Changes).
 *
 * Keys, while the view has focus and no text box does: j / k or ↓ / ↑ move
 * between files, s stages, u unstages, d discards (asks first), v switches
 * the diff layout, c writes the commit message, r reads git again, Esc
 * closes. In the message box, ⌘↵ commits and ⇧⌘↵ commits and pushes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  changesApi,
  entriesOf,
  failureOf,
  isLargePatch,
  type ChangeEntry,
  type ChangeFile,
  type DiscardPreview,
  type FilePatch,
  type WorktreeRef,
} from '@/lib/changes'
import { useChanges } from '@/lib/useChanges'
import { BranchIcon, CloseIcon } from './AppIcons'
import { CommitBox, OutcomeLine, RemoteActions, type CommitBoxHandle, type Outcome } from './CommitBox'
import { DiffView, type DiffLayout } from './DiffView'
import { GitHubStrip } from './PullRequest'

const LAYOUT_KEY = 'caprock.changes.layout'

const LETTER: Record<ChangeFile['status'], string> = {
  added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', untracked: 'U', conflicted: '!',
}

const LETTER_TONE: Record<ChangeFile['status'], string> = {
  added: 'text-ok', untracked: 'text-ok', deleted: 'text-danger', conflicted: 'text-danger',
  modified: 'text-warn', renamed: 'text-info', copied: 'text-info', typechange: 'text-fg-muted',
}

function loadLayout(): DiffLayout {
  try { return localStorage.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'unified' } catch { return 'unified' }
}

export interface ChangesViewProps {
  target: WorktreeRef
  /** What the header calls it: the project and the branch. */
  title: string
  /** The worktree's latest agent session, for "Use the agent's summary". */
  sessionId?: string
  onClose: () => void
  className?: string
}

export function ChangesView({ target: given, title, sessionId, onClose, className = '' }: ChangesViewProps) {
  const target = useMemo<WorktreeRef>(() => ({ projectId: given.projectId, worktree: given.worktree }), [given.projectId, given.worktree])
  const { changes, error, loading, refresh, accept } = useChanges(target)
  const entries = useMemo(() => entriesOf(changes), [changes])
  const [selected, setSelected] = useState<string | null>(null)
  const [layout, setLayout] = useState<DiffLayout>(loadLayout)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Outcome | null>(null)
  const [discard, setDiscard] = useState<{ preview: DiscardPreview; stale?: boolean } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const commitBox = useRef<CommitBoxHandle>(null)
  const lastIndex = useRef(0)

  useEffect(() => { try { localStorage.setItem(LAYOUT_KEY, layout) } catch { /* not kept */ } }, [layout])
  useEffect(() => { root.current?.focus() }, [])

  // Keep the selection on the same file when the list moves; when that file
  // left (staged, committed), take the one now at its place.
  const current = entries.find((e) => e.key === selected) ?? entries[Math.min(lastIndex.current, entries.length - 1)]
  const at = current ? entries.indexOf(current) : -1
  useEffect(() => { if (at >= 0) lastIndex.current = at }, [at])
  useEffect(() => {
    if (!current) return
    const sel = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(current.key) : current.key
    list.current?.querySelector<HTMLElement>(`[data-entry="${sel}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [current?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = useCallback(async (run: () => Promise<void>) => {
    setBusy(true)
    setNotice(null)
    try {
      await run()
    } catch (e) {
      setNotice({ ok: false, failure: failureOf(e) })
      refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const stage = (e: ChangeEntry) => act(async () => accept(await changesApi.stage(target, { paths: [e.file.path] })))
  const unstage = (e: ChangeEntry) => act(async () => accept(await changesApi.unstage(target, { paths: [e.file.path] })))
  const stageAll = () => act(async () => accept(await changesApi.stage(target, { all: true })))
  const unstageAll = () => act(async () => accept(await changesApi.unstage(target, { all: true })))
  const askDiscard = (paths: string[]) => act(async () => {
    const r = await changesApi.discard(target, paths)
    if (r.preview) setDiscard({ preview: r.preview })
  })
  const confirmDiscard = () => {
    if (!discard) return
    const d = discard
    void act(async () => {
      try {
        const r = await changesApi.discard(target, d.preview.files.map((f) => f.path), d.preview.confirm)
        if (r.changes) accept(r.changes)
        setDiscard(null)
      } catch (e) {
        const f = failureOf(e)
        if (f.kind === 'stale' && f.preview) { setDiscard({ preview: f.preview, stale: true }); return }
        setDiscard(null)
        throw e
      }
    })
  }

  const move = (delta: number) => {
    if (entries.length === 0) return
    const next = entries[Math.max(0, Math.min(entries.length - 1, (at < 0 ? 0 : at) + delta))]
    if (next) setSelected(next.key)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (t.matches('textarea, input, select') || e.metaKey || e.ctrlKey || e.altKey) return
    if (discard) {
      if (e.key === 'Escape') { e.preventDefault(); setDiscard(null) }
      return
    }
    const k = e.key
    if (k === 'j' || k === 'ArrowDown') move(1)
    else if (k === 'k' || k === 'ArrowUp') move(-1)
    else if (k === 's' && current && current.area !== 'staged') void stage(current)
    else if (k === 'u' && current?.area === 'staged') void unstage(current)
    else if (k === 'd' && current?.area === 'unstaged') void askDiscard([current.file.path])
    else if (k === 'v') setLayout((l) => (l === 'split' ? 'unified' : 'split'))
    else if (k === 'c') commitBox.current?.focus()
    else if (k === 'r') refresh()
    else if (k === 'Escape') onClose()
    else return
    e.preventDefault()
  }

  const staged = entries.filter((e) => e.area === 'staged')
  const unstaged = entries.filter((e) => e.area === 'unstaged')
  const conflicted = entries.filter((e) => e.area === 'conflicted')

  return (
    <div
      ref={root}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label={`Changes in ${title}`}
      className={`flex min-h-0 flex-col bg-[var(--app-chrome-bg)] text-fg outline-none ${className}`}
    >
      <header className="flex min-h-[44px] shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--app-hairline)] px-4 py-1.5">
        <h2 className="text-[13px] font-semibold tracking-[-0.01em]">Changes</h2>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-muted">
          <BranchIcon size={13} className="text-fg-faint" />
          <span className="mono truncate" title={changes?.path}>{title}</span>
        </span>
        {changes && <BranchState c={changes} />}
        <div className="ml-auto flex items-center gap-2">
          <RemoteActions target={target} changes={changes} onChanges={accept} onOutcome={setNotice} />
          <button type="button" onClick={onClose} aria-label="Close changes (Esc)" title="Close (Esc)" className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
            <CloseIcon size={13} />
          </button>
        </div>
      </header>
      <GitHubStrip target={target} title={title} sessionId={sessionId} />
      {notice && <div className="shrink-0 border-b border-[var(--app-hairline)] px-4 py-2"><OutcomeLine outcome={notice} onDismiss={() => setNotice(null)} /></div>}
      {changes?.state && (
        <p className="shrink-0 border-b border-[var(--app-hairline)] bg-warn/[0.07] px-4 py-1.5 text-[12px] text-fg">
          A {changes.state.replace(/ing$/, '')} is under way in this worktree; finish or abort it in a terminal.
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[340px] shrink-0 flex-col border-r border-[var(--app-hairline)]">
          <div ref={list} className="app-scroll min-h-0 flex-1 overflow-y-auto py-1" role="listbox" aria-label="Changed files">
            {error && !changes && <p className="px-4 py-3 text-[12px] text-danger">{error.message}</p>}
            {!changes && !error && <p className="px-4 py-3 text-[12px] text-fg-faint">Reading the worktree…</p>}
            {changes && entries.length === 0 && (
              <p className="px-4 py-3 text-[12.5px] leading-relaxed text-fg-muted">
                Nothing to commit.{changes.ahead > 0 ? ` ${changes.ahead} commit${changes.ahead === 1 ? '' : 's'} not pushed yet.` : ''}
              </p>
            )}
            <Section title="Conflicts" items={conflicted} current={current} onSelect={setSelected} />
            <Section
              title="Staged"
              items={staged}
              current={current}
              onSelect={setSelected}
              action={{ label: 'Unstage all', run: () => void unstageAll() }}
              row={(e) => <RowButton label="Unstage (u)" glyph="−" onClick={() => void unstage(e)} />}
              busy={busy}
            />
            <Section
              title="Changes"
              items={unstaged}
              current={current}
              onSelect={setSelected}
              action={{ label: 'Stage all', run: () => void stageAll() }}
              row={(e) => (
                <>
                  <RowButton label="Discard (d)" glyph="↺" onClick={() => void askDiscard([e.file.path])} />
                  <RowButton label="Stage (s)" glyph="+" onClick={() => void stage(e)} />
                </>
              )}
              busy={busy}
            />
            {changes?.truncated && <p className="px-4 py-2 text-[11px] text-fg-faint">Only the first files are listed; the worktree has more.</p>}
          </div>
          <div className="shrink-0 border-t border-[var(--app-hairline)] p-3">
            {discard ? (
              <DiscardConfirm d={discard} busy={busy} onKeep={() => setDiscard(null)} onDiscard={confirmDiscard} />
            ) : (
              <CommitBox ref={commitBox} target={target} changes={changes} onChanges={accept} sessionId={sessionId} />
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {current ? (
            <FileDiff key={`${current.key}`} target={target} entry={current} token={changes?.token ?? ''} layout={layout} onLayout={setLayout} onChanges={accept} onError={(f) => setNotice({ ok: false, failure: f })} />
          ) : (
            <div className="flex flex-1 items-center justify-center px-8 text-[12.5px] text-fg-faint">
              {loading ? 'Reading…' : changes && entries.length === 0 ? 'The working tree is clean.' : 'Pick a file to see its diff.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function BranchState({ c }: { c: NonNullable<ReturnType<typeof useChanges>['changes']> }) {
  return (
    <span className="num flex items-center gap-2 text-[11.5px] text-fg-faint">
      {c.detached && <span className="text-warn">detached HEAD</span>}
      {c.upstream ? <span title="upstream" className="mono">{c.upstream}</span> : c.remote ? <span>not published</span> : <span>no remote</span>}
      {c.ahead > 0 && <span title="commits to push" className="text-fg-muted">↑{c.ahead}</span>}
      {c.behind > 0 && <span title="commits to pull" className="text-fg-muted">↓{c.behind}</span>}
    </span>
  )
}

function Section({ title, items, current, onSelect, action, row, busy }: {
  title: string
  items: ChangeEntry[]
  current?: ChangeEntry
  onSelect: (key: string) => void
  action?: { label: string; run: () => void }
  row?: (e: ChangeEntry) => ReactNode
  busy?: boolean
}) {
  if (items.length === 0) return null
  return (
    <section aria-label={title} className="pb-1">
      <div className="flex h-[26px] items-center gap-1.5 px-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-faint">{title}</h3>
        <span className="num text-[11px] text-fg-faint">{items.length}</span>
        {action && (
          <button type="button" disabled={busy} onClick={action.run} className="ml-auto rounded-[5px] px-1.5 text-[11px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg disabled:opacity-50">
            {action.label}
          </button>
        )}
      </div>
      <ul>
        {items.map((e) => {
          const f = e.file
          const slash = f.path.lastIndexOf('/')
          const isCurrent = current?.key === e.key
          return (
            <li key={e.key} className="group relative px-2">
              <button
                type="button"
                role="option"
                aria-selected={isCurrent}
                aria-current={isCurrent ? 'true' : undefined}
                data-entry={e.key}
                onClick={() => onSelect(e.key)}
                title={f.orig_path ? `${f.orig_path} → ${f.path}` : f.path}
                className="app-row flex h-[26px] w-full min-w-0 items-center gap-2 rounded-[6px] px-2 text-left"
              >
                <span className={`mono w-3 shrink-0 text-center text-[11px] font-semibold ${LETTER_TONE[f.status]}`} aria-label={f.status}>{LETTER[f.status]}</span>
                <span className="mono flex min-w-0 flex-1 text-[12px]">
                  <span className="shrink-0 truncate text-fg">{f.path.slice(slash + 1)}</span>
                  {slash >= 0 && <span className="ml-1.5 min-w-0 truncate text-fg-faint">{f.path.slice(0, slash)}</span>}
                </span>
                <span className="num shrink-0 text-[10.5px] group-hover:invisible">
                  {f.binary ? <span className="text-fg-faint">bin</span> : (
                    <>
                      {f.additions > 0 && <span className="text-ok">+{f.additions}</span>}
                      {f.deletions > 0 && <span className="ml-1 text-danger">−{f.deletions}</span>}
                    </>
                  )}
                </span>
              </button>
              {row && (
                <span className="absolute right-3 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex group-focus-within:flex">
                  {row(e)}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function RowButton({ label, glyph, onClick }: { label: string; glyph: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(ev) => { ev.stopPropagation(); onClick() }}
      className="flex h-[20px] w-[20px] items-center justify-center rounded-[5px] text-[13px] leading-none text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
    >
      {glyph}
    </button>
  )
}

function DiscardConfirm({ d, busy, onKeep, onDiscard }: { d: { preview: DiscardPreview; stale?: boolean }; busy: boolean; onKeep: () => void; onDiscard: () => void }) {
  const files = d.preview.files
  const deletes = files.filter((f) => f.status === 'untracked').length
  return (
    <div role="alertdialog" aria-label="Confirm discard" className="grid gap-2 rounded-[9px] border border-danger/40 bg-danger/[0.06] p-3">
      <p className="text-[12.5px] leading-snug text-fg">
        {d.stale ? 'These files changed since you looked. ' : ''}
        Discard the unstaged changes to {files.length === 1 ? <span className="mono">{files[0]!.path}</span> : `${files.length} files`}?
        {deletes > 0 ? ` ${deletes === files.length ? 'It is new and will be deleted.' : `${deletes} new file${deletes === 1 ? '' : 's'} will be deleted.`}` : ''} This cannot be undone; staged changes are kept.
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onKeep} className="h-[28px] rounded-[7px] border border-[var(--app-hairline-strong)] px-3 text-[12.5px] text-fg hover:bg-[var(--app-row-hover)]">Keep</button>
        <button type="button" autoFocus disabled={busy} onClick={onDiscard} className="h-[28px] rounded-[7px] bg-danger px-3 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50">
          {busy ? 'Discarding…' : 'Discard'}
        </button>
      </div>
    </div>
  )
}

/** The selected file's diff, read again whenever the worktree's status moves. */
function FileDiff({ target, entry, token, layout, onLayout, onChanges, onError }: {
  target: WorktreeRef
  entry: ChangeEntry
  token: string
  layout: DiffLayout
  onLayout: (l: DiffLayout) => void
  onChanges: (c: NonNullable<ReturnType<typeof useChanges>['changes']>) => void
  onError: (f: ReturnType<typeof failureOf>) => void
}) {
  const [patch, setPatch] = useState<FilePatch | null>(null)
  const [err, setErr] = useState('')
  const [showLarge, setShowLarge] = useState(false)
  const [busy, setBusy] = useState(false)
  const staged = entry.area === 'staged'
  const path = entry.file.path

  useEffect(() => {
    let alive = true
    changesApi.diff(target, path, staged)
      .then((p) => { if (alive) { setPatch(p); setErr('') } })
      .catch((e: unknown) => { if (alive) setErr(failureOf(e).message) })
    return () => { alive = false }
  }, [target, path, staged, token])

  const hunk = useCallback((index: number) => {
    if (!patch) return
    setBusy(true)
    const req = { hunk: { path, index, token: patch.token } }
    ;(staged ? changesApi.unstage(target, req) : changesApi.stage(target, req))
      .then(onChanges)
      .catch((e: unknown) => onError(failureOf(e)))
      .finally(() => setBusy(false))
  }, [patch, path, staged, target, onChanges, onError])

  const f = entry.file
  const large = patch ? isLargePatch(patch) : false
  const canHunk = !!patch && f.status === 'modified' && entry.area !== 'conflicted' && !patch.binary && !patch.truncated
  return (
    <>
      <div className="flex h-[36px] shrink-0 items-center gap-2 border-b border-[var(--app-hairline)] px-4">
        <span className="mono min-w-0 truncate text-[12px] text-fg" title={path}>
          {f.orig_path ? <><span className="text-fg-faint">{f.orig_path} → </span>{path}</> : path}
        </span>
        <span className="shrink-0 text-[11px] text-fg-faint">{staged ? 'staged' : entry.area === 'conflicted' ? 'in conflict' : f.status === 'untracked' ? 'new file' : 'not staged'}</span>
        <div className="ml-auto flex shrink-0 items-center rounded-[7px] border border-[var(--app-hairline-strong)] p-0.5" role="group" aria-label="Diff layout (v)">
          {(['unified', 'split'] as const).map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={layout === l}
              onClick={() => onLayout(l)}
              className={`h-[22px] rounded-[5px] px-2 text-[11.5px] ${layout === l ? 'bg-[var(--app-row-active)] text-fg' : 'text-fg-muted hover:text-fg'}`}
            >
              {l === 'unified' ? 'Unified' : 'Side by side'}
            </button>
          ))}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {err ? (
          <p className="px-4 py-3 text-[12px] text-danger">{err}</p>
        ) : !patch ? (
          <p className="px-4 py-3 text-[12px] text-fg-faint">Reading the diff…</p>
        ) : patch.too_large ? (
          <p className="px-4 py-3 text-[12.5px] text-fg-muted">A new file of {fmtBytes(patch.bytes)}: too large to show here.</p>
        ) : patch.binary ? (
          <p className="px-4 py-3 text-[12.5px] text-fg-muted">A binary file; no text diff.</p>
        ) : !patch.patch.trim() ? (
          <p className="px-4 py-3 text-[12.5px] text-fg-muted">No line changes (a mode or an empty file).</p>
        ) : large && !showLarge ? (
          <div className="grid justify-items-start gap-2 px-4 py-4 text-[12.5px] text-fg-muted">
            <p>A large diff ({fmtBytes(patch.bytes)}{patch.truncated ? `, the first ${fmtBytes(patch.patch.length)} shown` : ''}), collapsed so the view stays quick.</p>
            <button type="button" onClick={() => setShowLarge(true)} className="h-[28px] rounded-[7px] border border-[var(--app-hairline-strong)] px-3 text-[12.5px] text-fg hover:bg-[var(--app-row-hover)]">Show the diff</button>
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col">
            {patch.truncated && <p className="shrink-0 border-b border-[var(--app-hairline)] px-4 py-1 text-[11px] text-fg-faint">Cut at {fmtBytes(patch.patch.length)} of {fmtBytes(patch.bytes)}.</p>}
            <div className="min-h-0 flex-1">
              <DiffView
                patch={patch.patch}
                layout={layout}
                resetKey={`${entry.key}`}
                hunkAction={canHunk ? { label: staged ? 'Unstage hunk' : 'Stage hunk', run: hunk, busy } : undefined}
              />
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} bytes`
}
