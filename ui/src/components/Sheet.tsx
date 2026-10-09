/**
 * A sheet: the app's modal, dropped from the top of the window as a macOS
 * sheet is. The × in its corner, Escape or a click outside closes it
 * (components/Dialog.tsx, shared with every other dialog); focus returns to
 * whatever had it before, so closing a sheet hands the keyboard back to the
 * terminal.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CloseButton, useBackdropClose, useEscapeToClose } from './Dialog'

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
  // Escape and the backdrop read the latest onClose (components/Dialog.tsx),
  // so the focus effect below depends on nothing. Callers pass an inline
  // arrow, so it is a new function on every render of theirs — and the app
  // shell re-renders on every poll and live event. While it was this effect's
  // dependency, each of those re-ran the effect: the cleanup handed focus back
  // to whatever had it before the sheet, and the set-up then focused the
  // sheet's first field. Someone typing the first message found the caret in
  // Project a moment later (owner, 2026-10-09: "focus sometimes jumps
  // between fields"). Focus moves on open and on close, never in between.
  useEscapeToClose(onClose)
  const backdrop = useBackdropClose(onClose)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    // Focus the first field unless something inside already took it. Never
    // the ×: Enter on an opened sheet must not close it.
    if (!panel.current?.contains(document.activeElement)) {
      panel.current?.querySelector<HTMLElement>('[autofocus], input, textarea, select, button:not([data-dialog-close])')?.focus()
    }
    return () => {
      before?.focus?.()
    }
  }, [])
  // On document.body, as every dialog's backdrop is (components/Dialog.tsx).
  return createPortal(
    <div data-dialog-backdrop="" className="fixed inset-0 z-40 flex items-start justify-center bg-black/25 px-4 pt-[10vh]" {...backdrop}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={{ maxWidth: width }}
        className="app-fade-in relative flex max-h-[78vh] w-full flex-col overflow-hidden rounded-[12px] border border-[var(--app-hairline-strong)] bg-panel shadow-[0_24px_64px_-20px_rgba(0,0,0,0.55)]"
      >
        {title ? (
          <div className="flex shrink-0 items-center gap-3 border-b border-[var(--app-hairline)] py-2 pl-5 pr-2.5">
            <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
            <CloseButton onClick={onClose} />
          </div>
        ) : (
          // A sheet without a title (the palette, the file picker, a
          // question) keeps the × in the same corner, over its first row;
          // that row leaves room for it (`SHEET_CLOSE_ROOM`).
          <CloseButton onClick={onClose} className="absolute right-2.5 top-2.5 z-10" />
        )}
        <div className="app-scroll min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--app-hairline)] px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/** Right padding for the first row of a sheet without a title, clear of its ×. */
export const SHEET_CLOSE_ROOM = 'pr-12'

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
