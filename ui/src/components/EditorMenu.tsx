/**
 * The sidebar's right-click menu on a project or a worktree (F18): open its
 * folder in each editor the daemon found, the default first. Closes on Esc,
 * a click elsewhere, or a choice.
 */
import { useEffect, useRef } from 'react'
import { api, errText, type EditorList } from '@/lib/api'
import { ExternalIcon } from './AppIcons'

export interface EditorMenuAt {
  x: number
  y: number
  path: string
  label: string
}

export function EditorMenu({ at, editors, onClose, onError }: {
  at: EditorMenuAt
  editors: EditorList | null
  onClose: () => void
  onError: (message: string) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose() }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  const ordered = editors ? [...editors.editors].sort((a, b) => Number(b.id === editors.preferred) - Number(a.id === editors.preferred)) : []
  const open = (id: string) => {
    onClose()
    api.openInEditor({ path: at.path, editor: id }).catch((e: unknown) => onError(`Could not open ${at.label}: ${errText(e)}`))
  }
  // Kept inside the window: a menu opened near the right or bottom edge flips.
  const left = Math.min(at.x, window.innerWidth - 268)
  const top = Math.min(at.y, window.innerHeight - 40 - ordered.length * 30)
  return (
    <div
      ref={box}
      role="menu"
      aria-label={`Open ${at.label}`}
      className="app-fade-in fixed z-50 grid w-[260px] gap-px rounded-[9px] border border-[var(--app-hairline-strong)] bg-panel p-1 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]"
      style={{ left, top }}
    >
      <p className="mono truncate px-2 pb-1 pt-0.5 text-[10.5px] text-fg-faint" title={at.path}>{at.path}</p>
      {ordered.length === 0 ? (
        <p className="px-2 py-1.5 text-[12px] text-fg-muted">No supported editor found (VS Code, Cursor, Zed, JetBrains).</p>
      ) : (
        ordered.map((e) => (
          <button
            key={e.id}
            type="button"
            role="menuitem"
            onClick={() => open(e.id)}
            className="app-row flex h-[28px] items-center gap-2 rounded-[6px] px-2 text-left text-[12.5px] text-fg"
          >
            <ExternalIcon size={13} className="text-fg-muted" />
            <span className="flex-1">Open in {e.name}</span>
            {e.id === editors?.preferred && <span className="text-[10.5px] text-fg-faint">default</span>}
          </button>
        ))
      )}
    </div>
  )
}
