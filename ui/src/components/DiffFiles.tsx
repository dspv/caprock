import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { FileDiff } from '@/lib/api'
import { parsePatch, type PatchLine } from '@/lib/patch'

/** Rows drawn per step. A patch can be 200 KB (gitdiff.MaxPatchBytes) — some
 *  thousands of rows — and drawing them all at once stalls a phone. */
const PAGE = 400

const STATUS_LETTER: Record<string, string> = { added: 'A', untracked: 'U', deleted: 'D', modified: 'M', renamed: 'R', copied: 'C' }

interface Selected { path: string; line: number }

/** The height of the dashboard's sticky header, which wraps to two or three
 *  rows on a phone: a file header sticks just under it, not behind it. */
function useShellHeight(): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-shell-header]')
    if (!el) return
    setHeight(el.offsetHeight)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return height
}

/**
 * The changed files of a diff, each expanding to its patch.
 *
 * Built for a phone first: rows are 44px, an open file's header sticks under
 * the page header while its patch scrolls, "next" closes the file and opens the
 * one after it, and a long patch is drawn a page at a time. Lines wrap or
 * scroll sideways inside the patch, never the page. When `onAsk` is given (a
 * controller phone on a session Caprock runs), tapping a line offers to ask
 * the agent about it.
 */
export function DiffFiles({ files, open, setOpen, wrap, onAsk }: {
  files: FileDiff[]
  open: Set<string>
  setOpen: Dispatch<SetStateAction<Set<string>>>
  wrap: boolean
  onAsk?: (path: string, line: number) => void
}) {
  const top = useShellHeight()
  const rows = useRef(new Map<string, HTMLLIElement>())
  const [scrollTo, setScrollTo] = useState<string | null>(null)
  const [selected, setSelected] = useState<Selected | null>(null)

  useEffect(() => {
    if (!scrollTo) return
    rows.current.get(scrollTo)?.scrollIntoView?.({ block: 'start' })
    setScrollTo(null)
  }, [scrollTo])

  const toggle = (path: string) => {
    const closing = open.has(path)
    setOpen((cur) => {
      const next = new Set(cur)
      if (!next.delete(path)) next.add(path)
      return next
    })
    // Closing a file read halfway down would leave the reader in whatever
    // follows it; bring its row back into view instead.
    const row = rows.current.get(path)
    if (closing && row && row.getBoundingClientRect().top < top) setScrollTo(path)
  }

  const goNext = (from: string, to: string) => {
    setOpen((cur) => {
      const s = new Set(cur)
      s.delete(from)
      s.add(to)
      return s
    })
    setScrollTo(to)
  }

  return (
    <>
      {onAsk && files.length > 0 && (
        <p className="px-3 py-1.5 text-[11px] text-fg-faint border-b border-border/60">Tap a line to ask the agent to change it.</p>
      )}
      <ul>
        {files.map((f, i) => {
          const isOpen = open.has(f.path)
          const nextPath = files[i + 1]?.path
          const slash = f.path.lastIndexOf('/')
          return (
            <li
              key={f.path}
              ref={(el) => { if (el) rows.current.set(f.path, el); else rows.current.delete(f.path) }}
              className="border-b border-border/60 last:border-0"
              style={{ scrollMarginTop: top }}
            >
              <div className={`flex items-stretch ${isOpen ? 'sticky z-[5] bg-panel border-b border-border/60' : ''}`} style={isOpen ? { top } : undefined}>
                <button
                  className="flex-1 min-w-0 text-left px-3 py-1.5 min-h-11 sm:min-h-0 flex items-center gap-2 sm:gap-3 hover:bg-panel-2"
                  onClick={() => toggle(f.path)}
                  aria-expanded={isOpen}
                >
                  {/* A disclosure caret, because a row that expands should look
                    * like one before it is clicked. */}
                  <span className={`text-fg-faint text-[10px] shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                  {/* A letter at phone width, where the word took a fifth of the row. */}
                  <span title={f.status} className={`mono text-[10px] w-3 sm:w-16 shrink-0 ${f.status === 'added' || f.status === 'untracked' ? 'text-ok' : f.status === 'deleted' ? 'text-danger' : 'text-fg-muted'}`}>
                    <span className="sm:hidden">{STATUS_LETTER[f.status] ?? f.status.charAt(0).toUpperCase()}</span>
                    <span className="hidden sm:inline">{f.status}</span>
                  </span>
                  {/* The directory gives way before the file name does. */}
                  <span className="mono text-[12px] min-w-0 flex">
                    {slash >= 0 && <span className="truncate shrink-[100] text-fg-faint">{f.path.slice(0, slash + 1)}</span>}
                    <span className="truncate">{f.path.slice(slash + 1)}</span>
                  </span>
                  <span className="ml-auto num text-[11px] shrink-0"><span className="text-ok">+{f.additions}</span> <span className="text-danger">−{f.deletions}</span></span>
                </button>
                {isOpen && nextPath && (
                  <button
                    className="shrink-0 min-w-11 px-2.5 text-[11px] text-fg-muted hover:text-fg hover:bg-panel-2 border-l border-border/60"
                    onClick={() => goNext(f.path, nextPath)}
                    aria-label={`Next file: ${nextPath}`}
                    title={`Next file: ${nextPath}`}
                  >
                    next ↓
                  </button>
                )}
              </div>
              {isOpen && f.patch && (
                <Patch
                  patch={f.patch}
                  wrap={wrap}
                  selected={selected?.path === f.path ? selected.line : undefined}
                  onSelect={onAsk ? (line) => setSelected(selected?.path === f.path && selected.line === line ? null : { path: f.path, line }) : undefined}
                />
              )}
              {isOpen && !f.patch && <div className="px-3 pb-2 text-[11px] text-fg-faint">{f.binary ? 'binary file' : 'no patch'}</div>}
              {isOpen && nextPath && (
                <button
                  className="w-full text-left px-3 py-1.5 min-h-11 sm:min-h-0 text-[12px] text-fg-muted hover:text-fg hover:bg-panel-2 border-t border-border/60 flex items-center gap-1.5 min-w-0"
                  onClick={() => goNext(f.path, nextPath)}
                >
                  <span className="shrink-0">Next file:</span>
                  <span className="mono truncate">{nextPath}</span>
                  <span className="shrink-0">↓</span>
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {onAsk && selected && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border-strong bg-panel px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex items-center gap-2 shadow-[var(--shadow-panel)]">
          <span className="min-w-0 flex-1 text-[12px] text-fg-muted truncate">
            In <span className="mono text-fg">{selected.path.slice(selected.path.lastIndexOf('/') + 1)}</span> around line <span className="num text-fg">{selected.line}</span>
          </span>
          <button
            className="shrink-0 rounded-sm bg-accent px-4 py-2 min-h-11 text-[14px] font-medium text-bg hover:brightness-110"
            onClick={() => { onAsk(selected.path, selected.line); setSelected(null) }}
          >
            Ask the agent
          </button>
          <button
            className="shrink-0 min-h-11 min-w-11 rounded-sm border border-border-strong text-[14px] text-fg-muted hover:text-fg"
            onClick={() => setSelected(null)}
            aria-label="Cancel"
          >
            ✕
          </button>
        </div>
      )}
    </>
  )
}

const ROW_TONE: Record<PatchLine['kind'], string> = {
  add: 'bg-ok/12',
  del: 'bg-danger/12',
  ctx: '',
  hunk: 'bg-info/8 text-info',
  meta: 'text-fg-faint',
}

function Patch({ patch, wrap, selected, onSelect }: { patch: string; wrap: boolean; selected?: number; onSelect?: (line: number) => void }) {
  const lines = useMemo(() => parsePatch(patch), [patch])
  const [shown, setShown] = useState(PAGE)
  const digits = useMemo(() => String(lines.reduce((m, l) => Math.max(m, l.old ?? 0, l.new ?? 0), 0)).length, [lines])
  // A gutter as wide as the longest number and no wider: on a 320px screen
  // every column it takes is a column of code that wraps.
  const gutter = { width: `calc(${digits}ch + 0.75rem)` }
  const left = lines.length - shown
  return (
    <div>
      <div className={`mono text-[11px] leading-[1.45] pb-1 ${wrap ? '' : 'overflow-x-auto'} sm:max-h-[50vh] sm:overflow-y-auto`}>
        <div className={wrap ? '' : 'w-max min-w-full'}>
          {lines.slice(0, shown).map((l, i) => {
            if (l.kind === 'hunk' || l.kind === 'meta') {
              return <div key={i} className={`px-3 ${wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'} ${ROW_TONE[l.kind]}`}>{l.text || ' '}</div>
            }
            const mark = l.text.charAt(0)
            const isSelected = selected !== undefined && l.at === selected
            return (
              <div
                key={i}
                className={`flex ${ROW_TONE[l.kind]} ${onSelect ? 'cursor-pointer' : ''} ${isSelected ? 'outline outline-1 -outline-offset-1 outline-accent bg-accent/15' : ''}`}
                onClick={onSelect && l.at !== undefined ? () => onSelect(l.at as number) : undefined}
              >
                <span className="hidden sm:block shrink-0 text-right pr-1.5 select-none text-fg-faint" style={gutter}>{l.old ?? ''}</span>
                <span className="shrink-0 text-right pr-2 select-none text-fg-faint" style={gutter}>
                  <span className="sm:hidden">{l.new ?? l.old}</span>
                  <span className="hidden sm:inline">{l.new ?? ''}</span>
                </span>
                <span className={`flex-1 min-w-0 pr-3 ${wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'}`}>
                  <span className={l.kind === 'add' ? 'text-ok' : l.kind === 'del' ? 'text-danger' : 'text-fg-faint'}>{mark === ' ' ? ' ' : mark}</span>
                  <span className={l.kind === 'ctx' ? 'text-fg-muted' : 'text-fg'}>{l.text.slice(1)}</span>
                </span>
              </div>
            )
          })}
        </div>
      </div>
      {left > 0 && (
        <div className="flex gap-2 px-3 py-1.5 border-t border-border/60">
          <button className="min-h-11 sm:min-h-0 px-2.5 py-1 text-[12px] text-fg-muted hover:text-fg border border-border rounded-sm" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, left)} more lines
          </button>
          <button className="min-h-11 sm:min-h-0 px-2.5 py-1 text-[12px] text-fg-muted hover:text-fg border border-border rounded-sm" onClick={() => setShown(lines.length)}>
            Show all {lines.length}
          </button>
        </div>
      )}
    </div>
  )
}
