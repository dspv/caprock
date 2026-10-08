/**
 * "Open file…" from the palette: the worktree's files (git's list — tracked
 * and new, not ignored), filtered as you type by a subsequence match that
 * prefers the file name. ↑ ↓ move, Enter opens the file in a tab, Escape
 * closes. The list is read once when the sheet opens; the filtering is here.
 */
import { useEffect, useMemo, useState } from 'react'
import type { WorktreeRef } from '@/lib/changes'
import { failureOf } from '@/lib/changes'
import { baseName, filesApi, rankFiles, type FileList } from '@/lib/files'
import { FileIcon } from './AppIcons'
import { Sheet } from './Sheet'

/** Rows drawn at once: enough to scroll, few enough to stay instant. */
const SHOWN = 60

export function FilePicker({ target, title, onOpen, onClose }: {
  target: WorktreeRef
  /** The project and branch, for the placeholder. */
  title: string
  onOpen: (path: string) => void
  onClose: () => void
}) {
  const [list, setList] = useState<FileList | null>(null)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  useEffect(() => {
    let alive = true
    filesApi.list(target)
      .then((l) => { if (alive) setList(l) })
      .catch((e: unknown) => { if (alive) setError(failureOf(e).message) })
    return () => { alive = false }
  }, [target])
  const shown = useMemo(() => rankFiles(list?.files ?? [], q, SHOWN), [list, q])
  const open = (path: string | undefined) => {
    if (!path) return
    onClose()
    window.setTimeout(() => onOpen(path), 0)
  }
  return (
    <Sheet label="Open file" onClose={onClose} width={600}>
      <div className="flex items-center gap-2 border-b border-[var(--app-hairline)] px-4">
        <input
          autoFocus
          aria-label="File name"
          role="combobox"
          aria-expanded="true"
          aria-controls="file-list"
          aria-activedescendant={shown[at] ? `file-${at}` : undefined}
          placeholder={`Open a file in ${title}…`}
          className="h-[48px] w-full bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-faint"
          value={q}
          onChange={(e) => { setQ(e.target.value); setAt(0) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setAt((n) => Math.min(shown.length - 1, n + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((n) => Math.max(0, n - 1)) }
            else if (e.key === 'Enter') { e.preventDefault(); open(shown[at]) }
          }}
        />
      </div>
      <ul id="file-list" role="listbox" aria-label="Files" className="grid max-h-[52vh] grid-cols-1 gap-px overflow-y-auto p-1.5">
        {error && <li className="px-3 py-3 text-[13px] text-danger">{error}</li>}
        {!list && !error && <li className="px-3 py-3 text-[13px] text-fg-faint">Reading the file list…</li>}
        {list && shown.length === 0 && <li className="px-3 py-3 text-[13px] text-fg-muted">{q ? `No file matches “${q}”.` : 'No files here.'}</li>}
        {shown.map((p, n) => {
          const slash = p.lastIndexOf('/')
          return (
            <li key={p}>
              <div
                id={`file-${n}`}
                role="option"
                aria-selected={n === at}
                title={p}
                onMouseMove={() => setAt(n)}
                onClick={() => open(p)}
                className={`flex h-[32px] cursor-default items-center gap-2.5 rounded-[7px] px-3 text-[13px] ${n === at ? 'bg-[var(--app-row-active)] text-fg' : 'text-fg'}`}
              >
                <FileIcon size={14} className="text-fg-muted" />
                <span className="mono shrink-0 text-[12.5px]">{baseName(p)}</span>
                {slash >= 0 && <span className="mono min-w-0 flex-1 truncate text-[11.5px] text-fg-faint">{p.slice(0, slash)}</span>}
              </div>
            </li>
          )
        })}
        {list?.truncated && <li className="px-3 py-2 text-[11px] text-fg-faint">Only the first {list.files.length.toLocaleString()} files are searched.</li>}
      </ul>
    </Sheet>
  )
}
