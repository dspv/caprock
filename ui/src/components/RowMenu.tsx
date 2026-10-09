/**
 * The small menu of a sidebar row: a project's (components/ProjectMenu.tsx)
 * and an open tab's (Close tab, Stop…). Opened by a button, a right-click,
 * or Shift+F10 / the context-menu key on the row.
 *
 * Keyboard: the first item takes focus; ↑ ↓ Home End move, Enter or Space
 * picks, Esc or Tab closes and gives focus back to what opened it. A click
 * outside, the window losing focus or a resize closes it too.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuAt {
  x: number
  y: number
}

export function MenuBox({ at, label, width = 248, refocusKey, onClose, children }: {
  at: MenuAt
  label: string
  width?: number
  /** Changes when the menu's content is swapped (a confirmation): focus goes to its first item again. */
  refocusKey?: unknown
  onClose: () => void
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: at.x, top: at.y })

  // Kept inside the window: near the right or bottom edge it flips.
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0
    const left = Math.max(8, Math.min(at.x, window.innerWidth - width - 8))
    const top = Math.max(8, at.y + h > window.innerHeight - 8 ? at.y - h : at.y)
    setPos((cur) => (cur.left === left && cur.top === top ? cur : { left, top }))
  })

  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled]), button')?.focus()
  }, [refocusKey])

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose() }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    const items = Array.from(box.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])
    if (items.length === 0) return
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    let next = -1
    if (e.key === 'ArrowDown') next = (i + 1) % items.length
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    if (next < 0) return
    e.preventDefault()
    e.stopPropagation()
    items[next]!.focus()
  }

  // On the page's body: the sidebar's backdrop filter makes it the containing
  // block of anything fixed inside it, so the menu would be cut at its edge.
  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="app-fade-in fixed z-50 grid gap-px rounded-[10px] border border-[var(--app-hairline-strong)] bg-panel p-1 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]"
      style={{ left: pos.left, top: pos.top, width }}
    >
      {children}
    </div>,
    document.body,
  )
}

export function MenuItem({ icon, label, hint, onClick, disabled, tone }: {
  icon: ReactNode
  label: string
  hint?: string
  onClick: () => void
  disabled?: boolean
  tone?: 'danger'
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`app-row flex h-[28px] w-full min-w-0 items-center gap-2 rounded-[6px] px-2 text-left text-[12.5px] disabled:pointer-events-none ${disabled ? 'text-fg-faint' : tone === 'danger' ? 'text-danger' : 'text-fg'}`}
    >
      <span className={tone === 'danger' ? 'text-danger' : 'text-fg-muted'}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[10.5px] text-fg-faint">{hint}</span>}
    </button>
  )
}

export function MenuSeparator() {
  return <span role="separator" className="mx-2 my-0.5 h-px bg-[var(--app-hairline)]" />
}
