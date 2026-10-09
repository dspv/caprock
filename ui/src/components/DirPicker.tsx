/**
 * Choosing a folder without typing its path.
 *
 * Starting a session required an absolute path, typed from memory, into a
 * dashboard that is already showing the repositories the reader works in every
 * day. That is the wrong way round.
 *
 * Two lists, in the order they are actually useful:
 *
 *  - **Recent** — where sessions have already run, newest first. Almost every
 *    session starts in a repository the person was in yesterday, so for most
 *    people this is the entire picker and nothing needs browsing. The daemon
 *    leaves out temp folders, its own data directory (quick chats) and agent
 *    worktrees under .claude/worktrees.
 *  - **Browse** — a folder browser (owner, 2026-10-09): it opens on the
 *    default folder, a breadcrumb walks back up, ↑ goes to the parent; a
 *    click selects a folder, a double-click or Enter goes into it, and
 *    *Choose* picks the selected folder, or the one shown when none is.
 *    ↑ ↓ move, → or Enter go in, ← or Backspace go up. Hidden folders are never
 *    listed. Repositories are marked and sorted first.
 *
 * The text field stays. It is the fastest input for anyone who knows the path,
 * it is what a paste goes into, and it is the only way to reach somewhere the
 * root does not cover. The lists write into it rather than replacing it, so
 * what will be used is always visible and always editable.
 *
 * The root is a setting rather than the whole filesystem: "where I keep my
 * code" is personal, and the narrower it is, the less the daemon's directory
 * listing can be asked for. See internal/api/browse.go.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api, type BrowseResponse, type RecentDir } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtAgo } from '@/lib/format'

export type PickerTab = 'recent' | 'browse'

export function DirPicker({
  value,
  onPick,
  start = '',
  tab: tabProp,
  onTab,
}: {
  value: string
  onPick: (dir: string) => void
  /** Where Browse opens: the default folder (`~/dev` works). Empty: the root. */
  start?: string
  /** Which list is shown, when the caller drives it (the sheet's ⌘B). */
  tab?: PickerTab
  onTab?: (t: PickerTab) => void
}) {
  const [ownTab, setOwnTab] = useState<PickerTab>('recent')
  const tab = tabProp ?? ownTab
  const setTab = (t: PickerTab) => { setOwnTab(t); onTab?.(t) }
  // Where the browse list currently is. Empty means the root, which is what
  // the daemon returns for a missing dir.
  const [dir, setDir] = useState(start)

  const recent = useApi(() => api.recentDirs(), [], { live: false })
  const browse = useApi(() => api.browse(dir), [dir], { live: false })

  // Open on whichever list can actually answer. A machine with no history — a
  // fresh install, the case where a picker matters most — would otherwise open
  // on an empty tab.
  useEffect(() => {
    if (recent.data && recent.data.length === 0) setTab('browse')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent.data])
  // A default folder that is gone opens the root rather than an error.
  useEffect(() => {
    if (browse.error && dir && dir === start) setDir('')
  }, [browse.error, dir, start])

  // The surface matches the .input above it — panel-2 on border-strong, same
  // radius. It sat on a transparent background with the lighter border,
  // directly beneath a field that had neither, and the two read as separate
  // surfaces at different opacities rather than as one control.
  return (
    // Inside a <label> (the dialogs' fields), a click on a row would also be
    // sent to the field's input and take the focus from the list.
    <div className="rounded-[3px] border border-border-strong bg-panel-2" onClick={(e) => { if (!(e.target as Element).closest('button')) e.preventDefault() }}>
      <div className="flex items-center gap-1 border-b border-border-strong px-2 py-1.5 text-[12px]">
        <Tab on={tab === 'recent'} onClick={() => setTab('recent')}>
          Recent
        </Tab>
        <Tab on={tab === 'browse'} onClick={() => setTab('browse')}>
          Browse
        </Tab>
      </div>

      {tab === 'recent' ? (
        // A fixed height, so the dialog does not jump as lists of different
        // lengths replace each other under the cursor. overflow-x-hidden as
        // well as -y: a long path is wider than the dialog.
        <div className="h-[196px] overflow-y-auto overflow-x-hidden">
          <RecentList rows={recent.data} value={value} onPick={onPick} />
        </div>
      ) : (
        <Browser data={browse.data} error={browse.error?.message} onOpen={setDir} onPick={onPick} />
      )}
    </div>
  )
}

function Tab({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-sm px-2 py-0.5 ${on ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:text-fg'}`}
    >
      {children}
    </button>
  )
}

function RecentList({
  rows,
  value,
  onPick,
}: {
  rows: RecentDir[] | undefined
  value: string
  onPick: (d: string) => void
}) {
  if (!rows) return <ul><Note>…</Note></ul>
  if (rows.length === 0) {
    return <ul><Note>No sessions yet — use Browse, or type a path.</Note></ul>
  }
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.dir}>
          <button
            type="button"
            onClick={() => onPick(r.dir)}
            className={`flex w-full min-w-0 items-center px-2.5 py-1 text-left text-[12px] hover:bg-panel ${value === r.dir ? 'bg-accent/10' : ''}`}
          >
            <span className="shrink-0 text-fg">{r.name}</span>
            <span className="mono ml-2 min-w-0 flex-1 truncate text-[11px] text-fg-faint" title={r.dir}>
              {r.dir}
            </span>
            <span className="shrink-0 pl-2 text-[11px] text-fg-faint">{fmtAgo(r.last_event_at)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The breadcrumb's steps from the root down to `dir`: `~ › dev › api`. */
export function crumbs(dir: string, root: string): { label: string; path: string }[] {
  const out = [{ label: '~', path: root }]
  if (!dir || dir === root || !dir.startsWith(root)) return out
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  let at = root
  for (const part of dir.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    at = `${at.replace(/[\\/]+$/, '')}${sep}${part}`
    out.push({ label: part, path: at })
  }
  return out
}

function Browser({
  data,
  error,
  onOpen,
  onPick,
}: {
  data: BrowseResponse | undefined
  error?: string
  onOpen: (d: string) => void
  onPick: (d: string) => void
}) {
  // The selected row, by path; a new folder starts with none.
  const [sel, setSel] = useState('')
  const list = useRef<HTMLUListElement>(null)
  const entries = data?.entries ?? []
  useEffect(() => { setSel('') }, [data?.dir])
  const at = entries.findIndex((e) => e.path === sel)
  const chosen = at >= 0 ? entries[at]! : undefined
  const choose = () => { if (data) onPick(chosen ? chosen.path : data.dir) }
  const enter = (path: string) => { onOpen(path); list.current?.focus() }

  const onKey = (e: ReactKeyboardEvent) => {
    if (!data || e.metaKey || e.ctrlKey || e.altKey) return
    const move = (i: number) => {
      const next = entries[Math.max(0, Math.min(entries.length - 1, i))]
      if (!next) return
      setSel(next.path)
      list.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(next.path)}"]`)?.scrollIntoView?.({ block: 'nearest' })
    }
    switch (e.key) {
      case 'ArrowDown': move(at + 1); break
      case 'ArrowUp': move(at < 0 ? entries.length - 1 : at - 1); break
      case 'Home': move(0); break
      case 'End': move(entries.length - 1); break
      case 'Enter': case 'ArrowRight': if (chosen) enter(chosen.path); else return; break
      case 'ArrowLeft': case 'Backspace': if (data.parent) enter(data.parent); else return; break
      default: return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div>
      <div className="flex min-w-0 items-center gap-1 border-b border-border-strong px-1.5 py-1 text-[11.5px]">
        <button
          type="button"
          disabled={!data?.parent}
          onClick={() => data?.parent && enter(data.parent)}
          aria-label="Up to the parent folder"
          title="Up (← or Backspace)"
          className="shrink-0 rounded-sm px-1.5 py-0.5 text-fg-muted hover:bg-panel hover:text-fg disabled:opacity-40"
        >
          ↑
        </button>
        <nav aria-label="Path" className="mono flex min-w-0 flex-1 items-center overflow-hidden text-fg-faint">
          {data && crumbs(data.dir, data.root).map((c, i, all) => (
            <span key={c.path} className={`flex min-w-0 items-center ${i < all.length - 2 ? 'shrink' : 'shrink-0'}`}>
              {i > 0 && <span aria-hidden className="px-0.5">›</span>}
              <button
                type="button"
                onClick={() => enter(c.path)}
                aria-current={i === all.length - 1 ? 'location' : undefined}
                className={`truncate rounded-sm px-0.5 hover:text-fg ${i === all.length - 1 ? 'text-fg' : ''}`}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
      </div>
      <ul
        ref={list}
        role="listbox"
        aria-label="Folders"
        tabIndex={0}
        onKeyDown={onKey}
        aria-activedescendant={chosen ? `dir-${at}` : undefined}
        className="h-[150px] overflow-y-auto overflow-x-hidden outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
      >
        {error && <Note>{error}</Note>}
        {!error && !data && <Note>…</Note>}
        {data && entries.length === 0 && <Note>Nothing here.</Note>}
        {entries.map((e, i) => (
          <li
            key={e.path}
            id={`dir-${i}`}
            role="option"
            aria-selected={e.path === sel}
            data-path={e.path}
            onClick={() => setSel(e.path)}
            onDoubleClick={() => enter(e.path)}
            title="Double-click to open"
            className={`flex min-w-0 cursor-default select-none items-center px-2.5 py-1 text-[12px] ${e.path === sel ? 'bg-accent/15 text-fg' : 'hover:bg-panel'}`}
          >
            <span className={`min-w-0 truncate ${e.repo ? 'text-fg' : 'text-fg-muted'}`}>{e.name}</span>
            {e.repo && <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wide text-accent">repo</span>}
            <span className="flex-1" />
            {/* Going in by touch, where a double-tap zooms. */}
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Open ${e.name}`}
              onClick={(ev) => { ev.stopPropagation(); enter(e.path) }}
              className="shrink-0 rounded-sm px-1.5 text-[12px] text-fg-faint hover:bg-panel-2 hover:text-fg"
            >
              ›
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-end gap-2 border-t border-border-strong px-2 py-1.5">
        <span className="mr-auto min-w-0 truncate text-[11px] text-fg-faint">
          <span className="mono">↑↓</span> select · <span className="mono">↩</span> open · <span className="mono">←</span> up
        </span>
        <button
          type="button"
          disabled={!data}
          onClick={choose}
          className="max-w-[60%] truncate rounded-[5px] border border-border-strong px-2 py-0.5 text-[12px] text-fg hover:bg-panel disabled:opacity-40"
        >
          {chosen ? `Choose ${chosen.name}` : 'Choose this folder'}
        </button>
      </div>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <li role="presentation" className="list-none px-2.5 py-3 text-[12px] text-fg-faint">{children}</li>
}
