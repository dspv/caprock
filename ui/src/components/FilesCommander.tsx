/**
 * The Files tab (ADR-089): a two-panel file manager, Norton Commander's
 * model in Caprock's palette, that knows about agents. Left is usually the
 * main checkout and right an agent's worktree; *Compare* tints what differs
 * (amber) and what is on one side only (green), and both panels follow each
 * other's folder; *What <agent> changed* keeps only the files that worktree
 * changed since it left its base. View (F3, ⌥3) shows the file under the
 * panels, and in compare mode its diff, main → worktree.
 *
 * Copy, move, new folder and delete act on the daemon's Files routes,
 * confined to the project's checkout and its worktrees; delete only ever
 * moves to the OS Trash. A paired device sees everything read-only.
 *
 * The component knows nothing about tabs: it fills its box, one panel at a
 * time under a switcher when the box is narrow, so it can be hosted in a
 * right-side drawer later as it is in a tab and on the dashboard page now.
 * `look` paints it Caprock's (the app's palette) or Norton's (blue, cyan
 * double frames, yellow marks, the F-key bar), kept per viewer.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { DialogBackdrop, CloseButton } from './Dialog'
import { BranchIcon, CopyIcon, EyeIcon, FileIcon, FolderIcon, FolderPlusIcon, PencilIcon, TrashIcon } from './AppIcons'
import { errText } from '@/lib/api'
import { isMacPlatform } from '@/lib/appmode'
import { keys } from '@/lib/appkeys'
import { filesApi } from '@/lib/files'
import {
  FILES_ACTIONS, absPath, changedNames, diffLineKind, filesAction, fmtDate, fmtSize, fsApi, joinRel, loadLook, parentRel, saveLook, takenNames,
  type CompareState, type FilesActionId, type FilesLook, type FsCompare, type FsEntry, type FsListing,
} from '@/lib/fsapi'
import './FilesCommander.css'

/** A folder Files can show: the project's checkout ('' key) or one of its worktrees. */
export interface FilesRoot {
  /** Git's worktree name; '' for the main checkout. */
  key: string
  /** The name a panel's header shows: the project's for the checkout, the worktree folder's otherwise. */
  name: string
  branch: string
  /** The folder on this machine. */
  path: string
  /** A live agent session working in this folder. */
  agent?: { title: string; state?: string }
}

export interface FilesCommanderProps {
  projectId: string
  projectName: string
  /** The checkout first, then its worktrees. */
  roots: readonly FilesRoot[]
  /** The worktree the right panel starts on (else the first with an agent, else the first worktree). */
  startRight?: string
  visible: boolean
  editorName?: string
  onOpenEditor?: (absPath: string, label: string) => void
}

interface Panel {
  root: string
  path: string
  cursor: number
  marked: string[]
}

interface Row {
  up?: boolean
  entry: FsEntry
}

type Dialog =
  | { kind: 'copy'; names: string[]; from: 0 | 1; overwrite?: string[] }
  | { kind: 'move'; names: string[]; from: 0 | 1 }
  | { kind: 'mkdir'; from: 0 | 1 }
  | { kind: 'delete'; names: string[]; from: 0 | 1 }

const UP: FsEntry = { name: '..', dir: true, size: 0, mtime: 0 }

function pickRight(roots: readonly FilesRoot[], start?: string): string {
  if (start !== undefined && roots.some((r) => r.key === start)) return start
  return roots.find((r) => r.key && r.agent)?.key ?? roots.find((r) => r.key)?.key ?? ''
}

export function FilesCommander({ projectId, projectName, roots, startRight, visible, editorName, onOpenEditor }: FilesCommanderProps) {
  const isMac = isMacPlatform()
  const [panels, setPanels] = useState<[Panel, Panel]>(() => [
    { root: '', path: '', cursor: 0, marked: [] },
    { root: pickRight(roots, startRight), path: '', cursor: 0, marked: [] },
  ])
  const [active, setActive] = useState<0 | 1>(() => (pickRight(roots, startRight) ? 1 : 0))
  const [listings, setListings] = useState<[FsListing | null, FsListing | null]>([null, null])
  const [errors, setErrors] = useState<[string, string]>(['', ''])
  const [tick, setTick] = useState(0)
  const [compareOn, setCompareOn] = useState(true)
  const [cmp, setCmp] = useState<FsCompare | null>(null)
  const [filterOn, setFilterOn] = useState(false)
  const [changed, setChanged] = useState<string[] | null>(null)
  const [quick, setQuick] = useState(false)
  const [look, setLookState] = useState<FilesLook>(loadLook)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [note, setNote] = useState('')
  const [narrow, setNarrow] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  const rootOf = useCallback((key: string) => roots.find((r) => r.key === key), [roots])
  const setLook = (l: FilesLook) => { setLookState(l); saveLook(l) }

  // Narrow: one panel under a switcher (a phone, a drawer).
  useLayoutEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 720))
    ro.observe(el)
    setNarrow(el.clientWidth > 0 && el.clientWidth < 720)
    return () => ro.disconnect()
  }, [])

  // A root that went (a worktree removed) puts its panel back on the checkout.
  useEffect(() => {
    setPanels((ps) => (ps.every((p) => roots.some((r) => r.key === p.root)) ? ps : (ps.map((p) => (roots.some((r) => r.key === p.root) ? p : { ...p, root: '', path: '', cursor: 0, marked: [] })) as [Panel, Panel])))
  }, [roots])

  // Read again when the tab comes to the front and when the window gets focus.
  useEffect(() => {
    if (!visible) return
    setTick((t) => t + 1)
    const onFocus = () => setTick((t) => t + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [visible])
  useEffect(() => {
    if (visible && !dialog) box.current?.focus({ preventScroll: true })
  }, [visible, dialog])

  // The two listings.
  const [l0, l1] = panels
  useEffect(() => {
    if (!visible) return
    let live = true
    for (const i of [0, 1] as const) {
      const p = panels[i]
      fsApi.list(projectId, p.root, p.path)
        .then((l) => { if (live) { setListings((cur) => (i === 0 ? [l, cur[1]] : [cur[0], l])); setErrors((cur) => (i === 0 ? ['', cur[1]] : [cur[0], ''])) } })
        .catch((e: unknown) => { if (live) { setListings((cur) => (i === 0 ? [null, cur[1]] : [cur[0], null])); setErrors((cur) => (i === 0 ? [errText(e), cur[1]] : [cur[0], errText(e)])) } })
    }
    return () => { live = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, l0.root, l0.path, l1.root, l1.path, tick, visible])

  const comparing = compareOn && l0.root !== l1.root && l0.path === l1.path
  useEffect(() => {
    if (!visible || !comparing) { setCmp(null); return }
    let live = true
    fsApi.compare(projectId, l0.root, l1.root, l0.path).then((c) => { if (live) setCmp(c) }).catch(() => { if (live) setCmp(null) })
    return () => { live = false }
  }, [projectId, comparing, l0.root, l1.root, l0.path, tick, visible])

  // The agent whose changes the filter shows: the right panel's worktree, else the left's.
  const agentRoot = l1.root || l0.root
  const baseRoot = agentRoot === l1.root ? l0.root : l1.root
  useEffect(() => {
    if (!visible || !agentRoot) { setChanged(null); return }
    let live = true
    fsApi.changed(projectId, agentRoot, baseRoot === agentRoot ? '' : baseRoot)
      .then((c) => { if (live) setChanged(c.changes.map((x) => x.path)) })
      .catch(() => { if (live) setChanged(null) })
    return () => { live = false }
  }, [projectId, agentRoot, baseRoot, tick, visible])
  const filtering = filterOn && changed !== null

  const rowsOf = useCallback((i: 0 | 1): Row[] => {
    const l = listings[i]
    const p = panels[i]
    const out: Row[] = p.path ? [{ up: true, entry: UP }] : []
    if (!l) return out
    const keep = filtering ? changedNames(changed!, p.path) : null
    for (const e of l.entries) if (!keep || keep.has(e.name)) out.push({ entry: e })
    return out
  }, [listings, panels, filtering, changed])
  const rows: [Row[], Row[]] = useMemo(() => [rowsOf(0), rowsOf(1)], [rowsOf])

  const stateOf = (i: 0 | 1, r: Row): CompareState | 'only' | undefined => {
    if (!cmp || r.up) return undefined
    const s = cmp.states[r.entry.name]
    if (s === 'diff') return 'diff'
    if ((s === 'left' && i === 0) || (s === 'right' && i === 1)) return 'only'
    return undefined
  }

  const cur = (i: 0 | 1): Row | undefined => rows[i][Math.min(panels[i].cursor, rows[i].length - 1)]
  const otherOf = (i: 0 | 1): 0 | 1 => (i === 0 ? 1 : 0)

  // Moving and opening.
  const update = (i: 0 | 1, f: (p: Panel) => Panel) => setPanels((ps) => (i === 0 ? [f(ps[0]), ps[1]] : [ps[0], f(ps[1])]))
  const go = (i: 0 | 1, path: string, from?: string) => {
    setPanels((ps) => {
      const next = ps.map((p, k) => {
        if (k === i || (comparing && p.root !== ps[i].root)) return { ...p, path, cursor: 0, marked: [] }
        return p
      }) as [Panel, Panel]
      return next
    })
    if (from !== undefined) pendingCursor.current = { i, name: from }
  }
  // After going up, the cursor lands on the folder we came from.
  const pendingCursor = useRef<{ i: 0 | 1; name: string } | null>(null)
  useEffect(() => {
    const pc = pendingCursor.current
    if (!pc) return
    const at = rows[pc.i].findIndex((r) => !r.up && r.entry.name === pc.name)
    if (at >= 0) { update(pc.i, (p) => ({ ...p, cursor: at })); pendingCursor.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  const open = (i: 0 | 1) => {
    const r = cur(i)
    if (!r) return
    if (r.up) { const p = panels[i].path; go(i, parentRel(p), p.split('/').pop()); return }
    if (r.entry.dir) { go(i, joinRel(panels[i].path, r.entry.name)); return }
    setQuick((q) => !q)
  }
  const goUp = (i: 0 | 1) => { const p = panels[i].path; if (p) go(i, parentRel(p), p.split('/').pop()) }
  const move = (i: 0 | 1, to: number) => update(i, (p) => ({ ...p, cursor: Math.max(0, Math.min(rows[i].length - 1, to)) }))
  const mark = (i: 0 | 1) => {
    const r = cur(i)
    if (!r || r.up) { move(i, panels[i].cursor + 1); return }
    update(i, (p) => ({ ...p, marked: p.marked.includes(r.entry.name) ? p.marked.filter((n) => n !== r.entry.name) : [...p.marked, r.entry.name], cursor: Math.min(rows[i].length - 1, p.cursor + 1) }))
  }
  const selection = (i: 0 | 1): string[] => {
    const m = panels[i].marked.filter((n) => rows[i].some((r) => !r.up && r.entry.name === n))
    if (m.length) return m
    const r = cur(i)
    return r && !r.up ? [r.entry.name] : []
  }

  const writable = listings[0]?.writable !== false && listings[1]?.writable !== false
  const trashOff = listings[active]?.trash_off

  const run = (id: FilesActionId) => {
    const i = active
    const names = selection(i)
    const r = cur(i)
    switch (id) {
      case 'view': setQuick((q) => !q); break
      case 'edit': {
        const l = listings[i]
        if (!onOpenEditor || !l || !r || r.up) { setNote(onOpenEditor ? 'Pick a file or folder first.' : 'No editor found on this computer.'); break }
        onOpenEditor(absPath(l.root, joinRel(panels[i].path, r.entry.name)), r.entry.name)
        break
      }
      case 'copy':
      case 'move':
      case 'delete':
        if (!writable) { setNote('Files is read-only on this device.'); break }
        if (!names.length) { setNote('Pick something first: move the cursor onto it, or mark it with Space.'); break }
        if (id === 'delete' && trashOff) { setNote(`Delete is off here: ${trashOff}.`); break }
        setDialog({ kind: id, names, from: i })
        break
      case 'mkdir':
        if (!writable) { setNote('Files is read-only on this device.'); break }
        setDialog({ kind: 'mkdir', from: i })
        break
    }
  }

  const done = (msg: string) => {
    setDialog(null)
    setNote(msg)
    setPanels(([a, b]) => [{ ...a, marked: [] }, { ...b, marked: [] }])
    setTick((t) => t + 1)
  }

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (dialog || e.nativeEvent.isComposing) return
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return
    const act = filesAction(e, isMac)
    const i = active
    const page = Math.max(1, Math.floor(((box.current?.querySelector('[data-rows]')?.clientHeight ?? 400) / 25)) - 1)
    let handled = true
    if (act) run(act)
    else if (e.metaKey || e.ctrlKey || e.altKey) handled = false
    else switch (e.key) {
      case 'Tab': setActive(otherOf(i)); break
      case 'ArrowDown': move(i, panels[i].cursor + 1); break
      case 'ArrowUp': move(i, panels[i].cursor - 1); break
      case 'PageDown': move(i, panels[i].cursor + page); break
      case 'PageUp': move(i, panels[i].cursor - page); break
      case 'Home': move(i, 0); break
      case 'End': move(i, rows[i].length - 1); break
      case 'Enter': open(i); break
      case 'Backspace': goUp(i); break
      case 'Insert':
      case ' ': mark(i); break
      case 'Escape': if (quick) setQuick(false); else handled = false; break
      default: handled = false
    }
    if (handled) { e.preventDefault(); e.stopPropagation() }
  }

  const swap = () => { setPanels(([a, b]) => [b, a]); setActive((a) => otherOf(a)) }
  const setRoot = (i: 0 | 1, key: string) => update(i, (p) => ({ ...p, root: key, path: comparing ? p.path : '', cursor: 0, marked: [] }))

  const agentName = rootOf(agentRoot)?.name ?? 'the agent'
  const rootsDiffer = l0.root !== l1.root
  const fkeys = (a: (typeof FILES_ACTIONS)[number]) => keys(a.key, isMac)
  const norton = look === 'norton'

  const panel = (i: 0 | 1) => {
    const p = panels[i]
    const l = listings[i]
    const r = rootOf(p.root)
    const list = rows[i]
    const counts = countMarks(l)
    const files = l ? l.entries.filter((e) => !e.dir) : []
    const bytes = files.reduce((n, e) => n + e.size, 0)
    const differ = cmp ? list.filter((x) => stateOf(i, x)).length : 0
    const pathText = `${r?.path ?? ''}${p.path ? `/${p.path}` : ''}`
    return (
      <section
        key={i}
        className={`fc-pane${active === i ? ' active' : ''}`}
        data-pane={i}
        aria-label={`${i === 0 ? 'Left' : 'Right'} panel: ${r?.name ?? ''}`}
        onMouseDown={() => setActive(i)}
      >
        <header className="fc-head">
          {norton ? <div className="fc-nc-title" title={pathText}><span>{pathText}</span></div> : null}
          <div className="fc-l1">
            <select className="fc-root" value={p.root} aria-label={`${i === 0 ? 'Left' : 'Right'} panel folder`} onChange={(e) => setRoot(i, e.target.value)} onMouseDown={(e) => e.stopPropagation()}>
              {roots.map((x) => <option key={x.key || 'main'} value={x.key}>{x.key ? x.name : `${projectName} (checkout)`}</option>)}
            </select>
            {r?.branch ? <span className={`fc-br${p.root ? ' agent' : ''}`}><BranchIcon size={11} />{r.branch}</span> : null}
            <span className="fc-counts">{counts}</span>
          </div>
          <div className="fc-path" title={pathText}><span>{pathText}</span></div>
          {r?.agent ? <div className="fc-sess"><span className="fc-dot" />{r.agent.title}{r.agent.state ? <span className="fc-state">{r.agent.state}</span> : null}</div>
            : !p.root ? <div className="fc-sess fc-faint">your checkout</div> : null}
        </header>
        <div className="fc-cols" aria-hidden><span /><span>Name</span><span className="r">Size</span><span className="r">Modified</span></div>
        <div className="fc-rows" data-rows={i} role="listbox" aria-label="Files" aria-multiselectable>
          {errors[i] ? <div className="fc-msg">{errors[i]}</div> : null}
          {list.map((x, j) => {
            const st = stateOf(i, x)
            const isCur = j === Math.min(p.cursor, list.length - 1)
            const marked = !x.up && p.marked.includes(x.entry.name)
            const unknown = !x.up && cmp?.unknown?.includes(x.entry.name)
            const cls = `fc-row${x.entry.dir ? ' dir' : ''}${isCur ? ' cur' : ''}${marked ? ' marked' : ''}${x.entry.git === '!' ? ' ign' : ''}${st ? ` c-${st}` : ''}`
            return (
              <div
                key={x.up ? '..' : x.entry.name}
                className={cls}
                role="option"
                aria-selected={isCur}
                data-name={x.entry.name}
                ref={isCur && active === i ? scrollIntoView : undefined}
                onMouseDown={() => update(i, (pp) => ({ ...pp, cursor: j }))}
                onDoubleClick={() => open(i)}
              >
                <span className={`fc-mk mk-${markClass(x.entry.git)}`}>{x.up ? '' : x.entry.git === '!' ? '' : x.entry.git ?? ''}</span>
                <span className="fc-nm">
                  <span className="fc-ic">{x.entry.dir ? <FolderIcon size={13} /> : <FileIcon size={13} />}</span>
                  <span className="fc-name">{x.entry.name}{x.entry.link ? ' →' : ''}</span>
                  {st === 'only' ? <span className="fc-tag">{i === 0 ? 'only here' : 'new'}</span> : null}
                  {unknown ? <span className="fc-tag fc-faint" title="Ignored by git: not compared">ignored</span> : null}
                </span>
                <span className="fc-sz">{x.up ? '' : x.entry.dir ? (norton ? '►SUB-DIR◄' : '') : fmtSize(x.entry.size)}</span>
                <span className="fc-dt">{x.up ? '' : fmtDate(x.entry.mtime)}</span>
              </div>
            )
          })}
        </div>
        <footer className="fc-foot">
          {p.marked.length ? <b className="fc-acc">{p.marked.length} marked · </b> : null}
          {l ? `${l.entries.length - files.length} folders, ${files.length} files · ${fmtSize(bytes)}` : '…'}
          {differ ? <span className="fc-warn"> · {differ} differ</span> : null}
          {l?.truncated ? ' · first 5,000 shown' : ''}
          {cmp?.partial ? ' · compared in part' : ''}
        </footer>
      </section>
    )
  }

  const switcher = (
    <div className="fc-switch" role="tablist" aria-label="Panels">
      {([0, 1] as const).map((i) => {
        const r = rootOf(panels[i].root)
        return (
          <button key={i} type="button" role="tab" aria-selected={active === i} className={`fc-sw${active === i ? ' on' : ''}`} onClick={() => setActive(i)}>
            <span className="a">{r?.agent ? <span className="fc-dot" /> : null}{i === 0 ? 'Left' : 'Right'}: {r?.key ? r.name : projectName}</span>
            <span className="b"><BranchIcon size={10} /> {r?.branch ?? ''}</span>
          </button>
        )
      })}
    </div>
  )

  return (
    <div
      ref={box}
      className={`fc${norton ? ' fc-norton' : ''}${narrow ? ' fc-narrow' : ''}`}
      tabIndex={0}
      onKeyDown={onKey}
      data-files=""
      aria-label={`Files: ${projectName}`}
    >
      <div className="fc-tools">
        {narrow ? switcher : null}
        <button type="button" className={`fc-chip${comparing ? ' on' : ''}`} disabled={!rootsDiffer} aria-pressed={comparing} onClick={() => {
          setCompareOn((c) => !c)
          if (!compareOn) setPanels((ps) => [ps[0], { ...ps[1], path: ps[0].path, cursor: 0, marked: [] }])
        }} title={rootsDiffer ? 'Tint what differs between the two folders; each panel follows the other' : 'Pick two different folders to compare'}>⇄ Compare</button>
        {changed !== null ? (
          <button type="button" className={`fc-chip${filtering ? ' on' : ''}`} aria-pressed={filtering} onClick={() => setFilterOn((f) => !f)} title={`Only the files ${agentName} changed since it left its base`}>
            What {agentName} changed <span className="n">{changed.length}</span>
          </button>
        ) : null}
        {!narrow ? <button type="button" className="fc-chip" onClick={swap}>Swap panels</button> : null}
        <span className="fc-legend" aria-hidden={!comparing}>
          {comparing ? <><span><i className="lg-diff" />differs</span><span><i className="lg-only" />one side only</span></> : null}
          <span><b className="mk-M">M</b> <b className="mk-A">A</b> <b className="mk-Q">?</b> git</span>
        </span>
        <span className="fc-look" role="group" aria-label="Look">
          <button type="button" className={!norton ? 'on' : ''} aria-pressed={!norton} onClick={() => setLook('caprock')}>Caprock</button>
          <button type="button" className={norton ? 'on' : ''} aria-pressed={norton} onClick={() => setLook('norton')}>Norton</button>
        </span>
      </div>
      <div className="fc-body">
        <div className="fc-panes">{narrow ? panel(active) : <>{panel(0)}{panel(1)}</>}</div>
        {quick ? (
          <QuickView
            projectId={projectId}
            root={panels[active].root}
            other={comparing ? panels[otherOf(active)].root : undefined}
            leftRoot={l0.root}
            rightRoot={l1.root}
            leftName={rootOf(l0.root)?.branch || projectName}
            rightName={rootOf(l1.root)?.branch || projectName}
            dir={panels[active].path}
            row={cur(active)}
            sheet={narrow}
            onClose={() => setQuick(false)}
            viewKey={fkeys(FILES_ACTIONS[0]!)}
          />
        ) : null}
      </div>
      {note ? <div className="fc-note" role="status">{note}<button type="button" onClick={() => setNote('')} aria-label="Dismiss">×</button></div> : null}
      <div className="fc-actions">
        {FILES_ACTIONS.map((a) => {
          const off = (!writable && a.id !== 'view' && a.id !== 'edit') || (a.id === 'delete' && !!trashOff) || (a.id === 'edit' && !onOpenEditor)
          const label = a.id === 'copy' || a.id === 'move' ? `${a.label} ${active === 0 ? '→' : '←'}` : a.id === 'edit' && editorName ? `Edit` : a.label
          return (
            <button
              key={a.id}
              type="button"
              className={`fc-abtn${a.id === 'delete' ? ' danger' : ''}${a.id === 'view' && quick ? ' on' : ''}`}
              disabled={off}
              title={off ? (a.id === 'delete' && trashOff ? `Delete is off here: ${trashOff}` : a.id === 'edit' ? 'No editor found on this computer' : 'Read-only on this device') : `${a.id === 'edit' && editorName ? `Open in ${editorName}` : a.label} · ${fkeys(a)} or F${a.digit}`}
              onClick={() => { run(a.id); box.current?.focus({ preventScroll: true }) }}
            >
              {norton ? <b className="fc-fnum">{a.digit}</b> : <ActionIcon id={a.id} />}
              <span className="fc-alabel">{label}</span>
              {norton ? null : <span className="fc-kbd">{fkeys(a)}</span>}
            </button>
          )
        })}
        <span className="fc-keynote">{isMac ? 'F3–F8 work too (with fn)' : 'F3–F8 work too'} · Tab switches · Space marks</span>
      </div>
      {dialog ? (
        <FilesDialog
          dialog={dialog}
          projectId={projectId}
          panels={panels}
          roots={roots}
          projectName={projectName}
          onClose={() => setDialog(null)}
          onDone={done}
          onAgain={setDialog}
        />
      ) : null}
    </div>
  )
}

function scrollIntoView(el: HTMLDivElement | null) {
  el?.scrollIntoView?.({ block: 'nearest' })
}

function markClass(g?: string): string {
  switch (g) {
    case 'M': return 'M'
    case 'A': return 'A'
    case '?': return 'Q'
    case 'D':
    case 'U': return 'D'
    case '.': return 'dot'
    default: return 'none'
  }
}

function countMarks(l: FsListing | null): ReactNode {
  if (!l?.git) return null
  const n = (m: string) => l.entries.filter((e) => e.git === m).length
  const parts: ReactNode[] = []
  for (const [m, cls] of [['M', 'M'], ['A', 'A'], ['?', 'Q']] as const) {
    const c = n(m)
    if (c) parts.push(<span key={m} className={`mk-${cls}`}>{c} {m}</span>)
  }
  return parts
}

function ActionIcon({ id }: { id: FilesActionId }) {
  switch (id) {
    case 'view': return <EyeIcon size={13} />
    case 'edit': return <PencilIcon size={13} />
    case 'copy': return <CopyIcon size={13} />
    case 'move': return <FileIcon size={13} />
    case 'mkdir': return <FolderPlusIcon size={13} />
    case 'delete': return <TrashIcon size={13} />
  }
}

/** The file under the cursor: its text, or in compare mode its diff left → right. */
function QuickView({ projectId, root, other, leftRoot, rightRoot, leftName, rightName, dir, row, sheet, onClose, viewKey }: {
  projectId: string
  root: string
  other?: string
  leftRoot: string
  rightRoot: string
  leftName: string
  rightName: string
  dir: string
  row?: Row
  sheet: boolean
  onClose: () => void
  viewKey: string
}) {
  const [body, setBody] = useState<{ lines: [string, string][]; head: string; stats?: [number, number] } | null>(null)
  const rel = row && !row.up ? joinRel(dir, row.entry.name) : ''
  const isDir = !row || row.up || row.entry.dir
  useEffect(() => {
    if (isDir) {
      setBody({ lines: [['note', row?.up ? 'The folder above. Enter or Backspace goes there.' : 'A folder. Enter opens it.']], head: '' })
      return
    }
    let live = true
    const t = window.setTimeout(() => {
      const plain = () => filesApi.read({ projectId, worktree: root }, rel).then((f) => {
        if (!live) return
        if (f.binary) setBody({ lines: [['note', `A binary file of ${fmtSize(f.size)}; it is not shown here.`]], head: fmtSize(f.size) })
        else {
          const ls = f.text.split('\n').slice(0, 3000).map((l): [string, string] => ['ctx', l])
          if (f.truncated) ls.push(['note', 'Only the first megabyte is shown.'])
          setBody({ lines: ls, head: `${fmtSize(f.size)} · read-only` })
        }
      })
      const p = other !== undefined
        ? fsApi.diff(projectId, leftRoot, rightRoot, rel).then((d) => {
          if (!live) return
          if (d.same) return plain().then(() => { if (live) setBody((b) => b && { ...b, head: 'no differences', lines: [['note', 'Same in both panels.'], ...b.lines] }) })
          if (d.binary || d.too_large) { setBody({ lines: [['note', d.binary ? 'A binary file: the two sides differ.' : 'Over 512 KB on a side: too large to diff here.']], head: `${leftName} → ${rightName}` }); return }
          const ls = d.patch.replace(/\n$/, '').split('\n').map((l): [string, string] => [diffLineKind(l), l])
          if (!d.left) ls.unshift(['note', `Only in ${rightName}.`])
          if (!d.right) ls.unshift(['note', `Only in ${leftName}.`])
          if (d.truncated) ls.push(['note', 'The diff is cut here.'])
          setBody({ lines: ls, head: `${leftName} → ${rightName}`, stats: [d.additions, d.deletions] })
        })
        : plain()
      p.catch((e: unknown) => { if (live) setBody({ lines: [['note', errText(e)]], head: '' }) })
    }, 90)
    return () => { live = false; window.clearTimeout(t) }
  }, [projectId, root, other, leftRoot, rightRoot, leftName, rightName, rel, isDir, row?.up])
  return (
    <div className={sheet ? 'fc-qv fc-sheet' : 'fc-qv'} aria-label="Quick view">
      <div className="fc-qv-head">
        <span className="fc-faint">Quick view</span>
        <b>{rel || (row?.up ? '..' : row?.entry.name ?? '')}</b>
        <span className="fc-faint">{body?.head}</span>
        <span className="r">
          {body?.stats ? <><span className="plus">+{body.stats[0]}</span><span className="minus">−{body.stats[1]}</span></> : null}
          {sheet ? <button type="button" className="fc-chip" onClick={onClose}>Close</button> : <><span className="fc-kbd">{viewKey}</span><span className="fc-kbd">Esc</span></>}
        </span>
      </div>
      <div className="fc-qv-body">
        {(body?.lines ?? []).map(([k, t], n) => <div key={n} className={k}>{t || ' '}</div>)}
      </div>
    </div>
  )
}

/** The confirm dialogs: each names the files and where they go. */
function FilesDialog({ dialog, projectId, panels, roots, projectName, onClose, onDone, onAgain }: {
  dialog: Dialog
  projectId: string
  panels: [Panel, Panel]
  roots: readonly FilesRoot[]
  projectName: string
  onClose: () => void
  onDone: (msg: string) => void
  onAgain: (d: Dialog) => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [name, setName] = useState(() => (dialog.kind === 'move' && dialog.names.length === 1 ? dialog.names[0]! : ''))
  const label = (key: string) => {
    const r = roots.find((x) => x.key === key)
    return r?.key ? `${r.name} (${r.branch})` : `${projectName} (your checkout${r?.branch ? `, ${r.branch}` : ''})`
  }
  const where = (p: Panel) => `${label(p.root)}${p.path ? ` / ${p.path}` : ''}`
  const act = async (f: () => Promise<unknown>, msg: string) => {
    setBusy(true)
    setErr('')
    try {
      await f()
      onDone(msg)
    } catch (e) {
      const taken = takenNames(e)
      if (taken && dialog.kind === 'copy' && !dialog.overwrite) { onAgain({ ...dialog, overwrite: taken }); setBusy(false); return }
      setErr(taken ? `Already there: ${taken.join(', ')}. Nothing was changed.` : errText(e))
      setBusy(false)
    }
  }
  const list = (names: string[]) => (
    <ul className="fc-dlg-list">{names.slice(0, 12).map((n) => <li key={n}>{n}</li>)}{names.length > 12 ? <li className="fc-faint">and {names.length - 12} more</li> : null}</ul>
  )
  let title = ''
  let bodyEl: ReactNode = null
  let primary: ReactNode = null
  if (dialog.kind === 'copy') {
    const src = panels[dialog.from]
    const dst = panels[dialog.from === 0 ? 1 : 0]
    const fromAgent = !!src.root && !dst.root
    const paths = dialog.names.map((n) => joinRel(src.path, n))
    title = dialog.overwrite ? `Replace ${dialog.overwrite.length === 1 ? dialog.overwrite[0] : `${dialog.overwrite.length} items`}?` : `Copy ${dialog.names.length === 1 ? dialog.names[0] : `${dialog.names.length} items`}`
    bodyEl = (
      <>
        <p>From <b>{where(src)}</b><br />to <b>{where(dst)}</b>:</p>
        {list(dialog.overwrite ?? dialog.names)}
        {dialog.overwrite ? <p className="fc-warn">These names are already there. Replacing writes over them; a folder's files are copied over its own.</p> : null}
        {fromAgent ? <p className="fc-faint">A plain file copy: the files land in your checkout as uncommitted changes. No git command runs.</p> : <p className="fc-faint">A plain file copy; no git command runs.</p>}
      </>
    )
    primary = <button type="button" className="fc-btn primary" disabled={busy} onClick={() => void act(() => fsApi.copy(projectId, { from: src.root, paths, to: dst.root, dir: dst.path, overwrite: !!dialog.overwrite }), `Copied ${dialog.names.length === 1 ? dialog.names[0] : `${dialog.names.length} items`}.`)}>{dialog.overwrite ? 'Replace' : 'Copy'}</button>
  } else if (dialog.kind === 'move') {
    const src = panels[dialog.from]
    const dst = panels[dialog.from === 0 ? 1 : 0]
    const paths = dialog.names.map((n) => joinRel(src.path, n))
    const one = dialog.names.length === 1
    title = one ? `Move or rename ${dialog.names[0]}` : `Move ${dialog.names.length} items`
    bodyEl = (
      <>
        {list(dialog.names)}
        <p>Move to <b>{where(dst)}</b>{one ? ', or rename it where it is:' : '.'} Nothing already there is replaced.</p>
        {one ? <input className="fc-input" aria-label="New name" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name && name !== dialog.names[0]) void act(() => fsApi.move(projectId, { from: src.root, paths, to: src.root, dir: src.path, name }), `Renamed to ${name}.`) }} /> : null}
      </>
    )
    primary = (
      <>
        {one ? <button type="button" className="fc-btn" disabled={busy || !name || name === dialog.names[0]} onClick={() => void act(() => fsApi.move(projectId, { from: src.root, paths, to: src.root, dir: src.path, name }), `Renamed to ${name}.`)}>Rename</button> : null}
        <button type="button" className="fc-btn primary" disabled={busy} onClick={() => void act(() => fsApi.move(projectId, { from: src.root, paths, to: dst.root, dir: dst.path }), `Moved ${one ? dialog.names[0] : `${dialog.names.length} items`}.`)}>Move to the other panel</button>
      </>
    )
  } else if (dialog.kind === 'mkdir') {
    const p = panels[dialog.from]
    title = 'New folder'
    const make = () => act(() => fsApi.mkdir(projectId, { worktree: p.root, dir: p.path, name }), `Made ${name}.`)
    bodyEl = (
      <>
        <p>In <b>{where(p)}</b>:</p>
        <input className="fc-input" aria-label="Folder name" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name) void make() }} />
      </>
    )
    primary = <button type="button" className="fc-btn primary" disabled={busy || !name} onClick={() => void make()}>Make folder</button>
  } else if (dialog.kind === 'delete') {
    const src = panels[dialog.from]
    const paths = dialog.names.map((n) => joinRel(src.path, n))
    title = `Move ${dialog.names.length === 1 ? dialog.names[0] : `${dialog.names.length} items`} to the Trash?`
    bodyEl = (
      <>
        <p>From <b>{where(src)}</b>:</p>
        {list(dialog.names)}
        <p className="fc-faint">They go to the Trash, where you can put them back. Nothing is deleted for good.</p>
      </>
    )
    primary = <button type="button" className="fc-btn danger" autoFocus disabled={busy} onClick={() => void act(() => fsApi.trash(projectId, { worktree: src.root, paths }), `Moved ${dialog.names.length === 1 ? dialog.names[0] : `${dialog.names.length} items`} to the Trash.`)}>Move to Trash</button>
  }
  return (
    <DialogBackdrop onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="fc-dlg" role="dialog" aria-modal="true" aria-label={title}>
        <div className="fc-dlg-head"><h2>{title}</h2><CloseButton onClick={onClose} /></div>
        <div className="fc-dlg-body">{bodyEl}{err ? <p className="fc-err" role="alert">{err}</p> : null}</div>
        <div className="fc-dlg-foot">
          <button type="button" className="fc-btn" onClick={onClose}>Cancel</button>
          {primary}
        </div>
      </div>
    </DialogBackdrop>
  )
}
