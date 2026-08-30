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
 *    people this is the entire picker and nothing needs browsing.
 *  - **Browse** — walking down from one root, for the first session in a new
 *    project. Repositories are marked and sorted first, because a repository is
 *    what is being looked for and everything else is the route to it.
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
import { useEffect, useState } from 'react'
import { api, type BrowseEntry, type RecentDir } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtAgo } from '@/lib/format'

export function DirPicker({ value, onPick }: { value: string; onPick: (dir: string) => void }) {
  const [tab, setTab] = useState<'recent' | 'browse'>('recent')
  // Where the browse list currently is. Empty means the root, which is what
  // the daemon returns for a missing dir.
  const [dir, setDir] = useState('')

  const recent = useApi(() => api.recentDirs(), [], { live: false })
  const browse = useApi(() => api.browse(dir), [dir], { live: false })

  // Open on whichever list can actually answer. A machine with no history — a
  // fresh install, the case where a picker matters most — would otherwise open
  // on an empty tab.
  useEffect(() => {
    if (recent.data && recent.data.length === 0) setTab('browse')
  }, [recent.data])

  return (
    <div className="rounded-sm border border-border">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5 text-[12px]">
        <Tab on={tab === 'recent'} onClick={() => setTab('recent')}>
          Recent
        </Tab>
        <Tab on={tab === 'browse'} onClick={() => setTab('browse')}>
          Browse
        </Tab>
        {tab === 'browse' && browse.data && (
          <span className="mono ml-auto truncate pl-2 text-[11px] text-fg-faint" title={browse.data.dir}>
            {shorten(browse.data.dir, browse.data.root)}
          </span>
        )}
      </div>

      {/* A fixed height, so the dialog does not jump as lists of different
        * lengths replace each other under the cursor. */}
      <div className="h-[168px] overflow-y-auto">
        {tab === 'recent' ? (
          <RecentList rows={recent.data} value={value} onPick={onPick} />
        ) : (
          <BrowseList
            data={browse.data}
            value={value}
            onOpen={setDir}
            onPick={onPick}
            error={browse.error?.message}
          />
        )}
      </div>
    </div>
  )
}

function Tab({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
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
  if (!rows) return <Note>…</Note>
  if (rows.length === 0) {
    return <Note>No sessions yet — use Browse, or type a path.</Note>
  }
  return (
    <ul>
      {rows.map((r) => (
        <Row key={r.dir} selected={value === r.dir} onClick={() => onPick(r.dir)}>
          <span className="truncate text-fg">{r.name}</span>
          <span className="mono ml-2 flex-1 truncate text-[11px] text-fg-faint" title={r.dir}>
            {r.dir}
          </span>
          <span className="shrink-0 pl-2 text-[11px] text-fg-faint">{fmtAgo(r.last_event_at)}</span>
        </Row>
      ))}
    </ul>
  )
}

function BrowseList({
  data,
  value,
  onOpen,
  onPick,
  error,
}: {
  data: { dir: string; parent: string; root: string; entries: BrowseEntry[] } | undefined
  value: string
  onOpen: (d: string) => void
  onPick: (d: string) => void
  error?: string
}) {
  if (error) return <Note>{error}</Note>
  if (!data) return <Note>…</Note>
  return (
    <ul>
      {/* Absent at the root rather than disabled: an "up" that refuses is worse
        * than no "up", and the daemon reports the boundary for exactly this. */}
      {data.parent && (
        <Row selected={false} onClick={() => onOpen(data.parent)}>
          <span className="text-fg-muted">↑ up</span>
        </Row>
      )}
      {data.entries.length === 0 && <Note>Nothing here.</Note>}
      {data.entries.map((e) => (
        <Row
          key={e.path}
          selected={value === e.path}
          // A repository is what someone came for, so clicking one picks it.
          // A plain folder is the route, so clicking it goes in. Both are
          // reachable either way — the arrow descends, the name picks.
          onClick={() => (e.repo ? onPick(e.path) : onOpen(e.path))}
        >
          <span className={e.repo ? 'text-fg' : 'text-fg-muted'}>{e.name}</span>
          {e.repo && <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wide text-accent">repo</span>}
          <span className="flex-1" />
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation()
              e.repo ? onOpen(e.path) : onPick(e.path)
            }}
            className="shrink-0 px-1 text-[11px] text-fg-faint hover:text-fg"
            title={e.repo ? 'Open this folder' : 'Use this folder'}
          >
            {e.repo ? '›' : 'use'}
          </button>
        </Row>
      ))}
    </ul>
  )
}

function Row({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center px-2.5 py-1 text-left text-[12px] hover:bg-panel-2 ${
          selected ? 'bg-accent/10' : ''
        }`}
      >
        {children}
      </button>
    </li>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-2.5 py-3 text-[12px] text-fg-faint">{children}</p>
}

/** `/Users/you/dev/api` under root `/Users/you` reads as `~/dev/api`. */
function shorten(dir: string, root: string): string {
  if (dir === root) return '~'
  if (dir.startsWith(root + '/')) return '~' + dir.slice(root.length)
  return dir
}
