import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * The secondary actions of a page, behind one button. The session page in
 * the app had five ways to pick a conversation up in one row, wrapping to a
 * second line; one stays in view and the rest are here.
 */
export function MoreMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="rounded-[6px] border border-border px-2 py-1 text-[12px] text-fg-muted hover:text-fg"
      >
        More ▾
      </button>
      {open && (
        <span className="absolute left-0 top-full z-20 mt-1 grid min-w-[220px] gap-2 rounded-[8px] border border-border-strong bg-panel p-3 shadow-lg">
          {children}
        </span>
      )}
    </span>
  )
}
