/**
 * A sheet: the app's modal, dropped from the top of the window as a macOS
 * sheet is. Escape or a click outside closes it; focus returns to whatever
 * had it before, so closing a sheet hands the keyboard back to the terminal.
 */
import { useEffect, useRef, type ReactNode } from 'react'

export function Sheet({
  title,
  onClose,
  children,
  footer,
  width = 520,
  label,
}: {
  title?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  label: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    // Focus the first field unless something inside already took it.
    if (!panel.current?.contains(document.activeElement)) {
      panel.current?.querySelector<HTMLElement>('[autofocus], input, textarea, select, button')?.focus()
    }
    return () => {
      window.removeEventListener('keydown', onKey, true)
      before?.focus?.()
    }
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/25 px-4 pt-[10vh]" onMouseDown={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ maxWidth: width }}
        className="app-fade-in flex max-h-[78vh] w-full flex-col overflow-hidden rounded-[12px] border border-[var(--app-hairline-strong)] bg-panel shadow-[0_24px_64px_-20px_rgba(0,0,0,0.55)]"
      >
        {title && (
          <div className="shrink-0 border-b border-[var(--app-hairline)] px-5 py-3.5">
            <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
          </div>
        )}
        <div className="app-scroll min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--app-hairline)] px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

/** The sheet's buttons: one primary, the rest quiet. */
export function SheetButton({ primary, children, ...rest }: { primary?: boolean; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`h-[30px] rounded-[7px] px-3.5 text-[13px] font-medium disabled:opacity-50 ${
        primary ? 'bg-accent text-panel hover:brightness-110' : 'border border-[var(--app-hairline-strong)] text-fg hover:bg-[var(--app-row-hover)]'
      }`}
    >
      {children}
    </button>
  )
}

/** A labelled field inside a sheet. */
export function SheetField({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1.5">
      <span className="flex items-baseline gap-2 text-[12px] font-medium text-fg-muted">
        {label}
        {hint && <span className="font-normal text-fg-faint">{hint}</span>}
      </span>
      {children}
    </label>
  )
}
