/**
 * The three ways out of every dialog, in one place: a × in its header, a
 * click on the dimmed backdrop, and Escape.
 *
 * Each dialog used to bring its own. Some had a 16px grey "×" glyph, some a
 * "✕", the Quick chat sheet had none at all, and only the sheets and the
 * upsell dialogs listened for Escape — the owner opened Quick chat and could
 * not find how to close it (2026-10-10). Now a dialog takes `DialogBackdrop`
 * (backdrop click and Escape) and `CloseButton` (the ×), or `Sheet`, which is
 * built on both, and they all close the same way.
 *
 * **Escape closes the top dialog only.** Dialogs register on a stack; one
 * listener, in the capture phase, closes the newest and stops the key there,
 * so a dialog opened over another closes alone, and nothing under it — a
 * terminal, the Settings page — sees the key.
 *
 * **The backdrop is drawn on `document.body`.** A dialog opened from the
 * app's sidebar was confined to the sidebar: its translucent material
 * (`backdrop-filter`) makes a containing block for `position: fixed`, so the
 * "full-window" backdrop was 260px wide and the panel was cut off. A portal
 * puts every backdrop at the top of the page, whatever opened it.
 *
 * **A backdrop click is a click that both started and ended on the
 * backdrop.** Selecting text in a field and letting go outside the panel
 * ends the drag on the backdrop; closing then would throw away what was
 * typed.
 */
import { useEffect, useRef, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type Closer = { close: () => void }
const stack: Closer[] = []
let listening = false

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.isComposing) return
  const top = stack[stack.length - 1]
  if (!top) return
  e.preventDefault()
  e.stopPropagation()
  top.close()
}

/** Whether any dialog is open: a page's own Escape (Settings) leaves the key to it. */
export function dialogOpen(): boolean {
  return stack.length > 0
}

/** Escape closes this dialog while it is the newest one open. `onClose` may change on every render. */
export function useEscapeToClose(onClose: () => void, enabled = true) {
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => {
    if (!enabled) return
    const entry: Closer = { close: () => latest.current() }
    stack.push(entry)
    if (!listening) {
      window.addEventListener('keydown', onKey, true)
      listening = true
    }
    return () => {
      const i = stack.indexOf(entry)
      if (i >= 0) stack.splice(i, 1)
      if (stack.length === 0 && listening) {
        window.removeEventListener('keydown', onKey, true)
        listening = false
      }
    }
  }, [enabled])
}

/** Handlers for a backdrop: close on a click that began and ended on it, never on a drag out of the panel. */
export function useBackdropClose(onClose: () => void) {
  const down = useRef(false)
  const latest = useRef(onClose)
  latest.current = onClose
  return {
    onMouseDown: (e: MouseEvent<HTMLElement>) => { down.current = e.target === e.currentTarget },
    onClick: (e: MouseEvent<HTMLElement>) => {
      const fromBackdrop = down.current
      down.current = false
      if (fromBackdrop && e.target === e.currentTarget) latest.current()
    },
  }
}

/**
 * The dimmed layer behind a dialog, on `document.body`: a click on it, or
 * Escape, calls `onClose`. The panel goes inside as `children`; its
 * placement and the backdrop's colour are the caller's `className`.
 */
export function DialogBackdrop({ onClose, className, children, ...rest }: {
  onClose: () => void
  className: string
  children: ReactNode
} & Omit<HTMLAttributes<HTMLDivElement>, 'onClick' | 'onMouseDown' | 'className' | 'children'>) {
  useEscapeToClose(onClose)
  const handlers = useBackdropClose(onClose)
  return createPortal(
    <div {...rest} data-dialog-backdrop="" className={className} {...handlers}>
      {children}
    </div>,
    document.body,
  )
}

/**
 * The ×: the same 30px button in every dialog's header, 44px on a phone.
 * `label` names what it closes for a screen reader ("Close", "Close
 * settings"); the tooltip adds the key.
 */
export function CloseButton({ onClick, label = 'Close', title, className = '' }: {
  onClick: () => void
  label?: string
  title?: string
  className?: string
}) {
  return (
    <button
      type="button"
      data-dialog-close=""
      aria-label={label}
      title={title ?? `${label} (Esc)`}
      onClick={onClick}
      className={`inline-flex h-[30px] w-[30px] shrink-0 max-sm:h-11 max-sm:w-11 items-center justify-center rounded-[7px] text-fg-muted transition-colors hover:bg-[color-mix(in_srgb,var(--color-fg)_8%,transparent)] hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/60 motion-reduce:transition-none ${className}`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  )
}
