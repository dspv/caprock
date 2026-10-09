/**
 * The tab strip's + (owner, 2026-10-09: "make it amber, or better a
 * dropdown: new agent, quick chat, etc.", translated). An amber outline like
 * the sidebar's New agent; a click opens a short menu of everything that
 * opens a tab — each with its key — and nothing else. ↑ ↓ move, Enter or a
 * click runs one, Esc or a click outside closes and gives the focus back.
 *
 * The strip's separate >_ (new shell) button went with it: New shell is the
 * menu's third row and ⌘T, and two lone icons side by side read as one
 * ambiguous control.
 *
 * Portalled to <body>: the strip clips its tabs (overflow hidden), and the
 * sidebar's backdrop filter would make any fixed element inside it relative.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PlusIcon } from './AppIcons'

export interface NewMenuItem {
  id: string
  label: string
  /** The key, as the shortcuts sheet spells it (⇧⌘N). */
  hint?: string
  icon?: ReactNode
  run: () => void
}

export function NewMenu({ items }: { items: readonly NewMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(0)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !button.current) return
    const r = button.current.getBoundingClientRect()
    // Under the button, kept inside the window.
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 248)), top: r.bottom + 4 })
  }, [open])
  useEffect(() => {
    if (!open || !pos) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const away = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', away, true)
    return () => window.removeEventListener('mousedown', away, true)
  }, [open, pos])

  const close = (focusBack = true) => {
    setOpen(false)
    if (focusBack) button.current?.focus()
  }
  const run = (item: NewMenuItem) => { close(false); item.run() }
  const move = (i: number) => {
    const n = items.length
    const next = ((i % n) + n) % n
    setAt(next)
    menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[next]?.focus()
  }
  const onKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown': move(at + 1); break
      case 'ArrowUp': move(at - 1); break
      case 'Home': move(0); break
      case 'End': move(items.length - 1); break
      case 'Escape': close(); break
      case 'Tab': close(); return
      default: return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        title="New…"
        aria-label="New"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setAt(0); setOpen((o) => !o) }}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setAt(0); setOpen(true) } }}
        className="app-primary flex h-[26px] w-[30px] items-center justify-center rounded-[7px] border transition-colors duration-100 motion-reduce:transition-none"
      >
        <PlusIcon size={15} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menu}
          role="menu"
          aria-label="New"
          onKeyDown={onKey}
          style={{ left: pos.left, top: pos.top }}
          className="app-fade-in fixed z-50 w-[240px] rounded-[9px] border border-[var(--app-hairline-strong)] bg-panel p-1 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]"
        >
          {items.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={i === at ? 0 : -1}
              onMouseEnter={() => setAt(i)}
              onClick={() => run(item)}
              className={`flex h-[30px] w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-[13px] text-fg outline-none ${i === at ? 'bg-[var(--app-row-active)]' : ''}`}
            >
              <span aria-hidden className="flex w-[14px] shrink-0 justify-center text-fg-muted">{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && <kbd className="app-kbd shrink-0 !text-[11.5px]">{item.hint}</kbd>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
