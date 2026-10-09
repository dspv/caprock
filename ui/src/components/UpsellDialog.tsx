/**
 * The frame both upsell dialogs share — Caprock for Teams and Caprock Premium —
 * so they read as one thing: a picture of what you get first, a few short
 * lines after it, then the two ways forward.
 *
 * The picture is drawn in the Week card's language (the same ground, the same
 * characters, the same big figures). Any figure in it is an example and says
 * so with a tag on the picture itself, not in a footnote (rule 6): someone
 * glancing at a big number must never take it for one of theirs.
 *
 * It behaves like a dialog: the ×, Escape and the backdrop close it
 * (components/Dialog.tsx), focus moves into it when it opens, Tab stays inside
 * it, and focus goes back to whatever opened it when it closes.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { CloseButton, DialogBackdrop } from './Dialog'
import './WeekCard.css'

/** Focus into the panel on open, Tab kept inside it, focus back on close. Escape is DialogBackdrop's. */
export function useDialogFocus() {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const focusables = () =>
      [...(panel.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]
    // The first control that is not the ×: Enter on an opened dialog must not close it.
    const first = focusables().find((el) => !el.hasAttribute('data-dialog-close')) ?? focusables()[0]
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const f = focusables()
      if (f.length === 0) return
      const first = f[0]!
      const last = f[f.length - 1]!
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      try { opener?.focus?.() } catch { /* the opener may be gone */ }
    }
  }, [])
  return panel
}

export function UpsellDialog({ label, eyebrow, title, onClose, picture, children, actions, footer }: {
  label: string
  eyebrow: string
  title: string
  onClose: () => void
  picture: ReactNode
  children: ReactNode
  actions: ReactNode
  footer: ReactNode
}) {
  const panel = useDialogFocus()
  return (
    <DialogBackdrop
      onClose={onClose}
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/55 px-3 py-[6vh] sm:px-4"
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div
        ref={panel}
        className="w-[520px] max-w-full overflow-hidden rounded-[14px] border border-border-strong bg-panel shadow-[var(--shadow-panel)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 px-5 pt-4">
          <div className="min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-accent">{eyebrow}</p>
            <h2 className="mt-1 text-[19px] font-semibold leading-snug tracking-[-0.01em] text-fg">{title}</h2>
          </div>
          <CloseButton onClick={onClose} className="-mr-2 -mt-1 ml-auto" />
        </header>
        <div className="px-5 pt-3">{picture}</div>
        <div className="px-5 pt-4">{children}</div>
        <div className="mt-4 border-t border-border px-5 py-4">{actions}</div>
        <footer className="border-t border-border px-5 py-2.5 text-[12px]">{footer}</footer>
      </div>
    </DialogBackdrop>
  )
}

/**
 * A miniature card: the Week card's ground and type at dialog size, with the
 * "example" tag that every illustrated figure has to carry.
 */
export function MiniCard({ tag = 'Example', label, children }: { tag?: string; label: string; children: ReactNode }) {
  return (
    <figure className="wk-card relative m-0 rounded-[12px] border border-border px-4 py-3.5" role="img" aria-label={label}>
      <span className="absolute right-3 top-3 rounded-full border border-border-strong px-2 py-[1px] font-mono text-[10px] uppercase tracking-[0.14em] text-fg-muted">
        {tag}
      </span>
      {children}
    </figure>
  )
}

/** One benefit line: a small amber icon and a sentence. */
export function Benefit({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[13.5px] leading-snug text-fg">
      <span aria-hidden className="mt-[1px] inline-flex h-5 w-5 flex-none items-center justify-center rounded-md bg-accent/12 text-accent">
        {icon}
      </span>
      <span>{children}</span>
    </li>
  )
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

/** Small line icons, drawn here so nothing is fetched. */
export const Icon = {
  pie: <svg width="13" height="13" viewBox="0 0 16 16"><path d="M8 2a6 6 0 1 0 6 6H8z" {...stroke} /><path d="M10 1.5A5 5 0 0 1 14.5 6H10z" {...stroke} /></svg>,
  loop: <svg width="13" height="13" viewBox="0 0 16 16"><path d="M3 8a5 5 0 0 1 8.5-3.5L13 6M13 2.5V6H9.5M13 8a5 5 0 0 1-8.5 3.5L3 10M3 13.5V10h3.5" {...stroke} /></svg>,
  stack: <svg width="13" height="13" viewBox="0 0 16 16"><path d="M8 2 14 5 8 8 2 5zM2 8l6 3 6-3M2 11l6 3 6-3" {...stroke} /></svg>,
  pr: <svg width="13" height="13" viewBox="0 0 16 16"><circle cx="4" cy="3.5" r="1.5" {...stroke} /><circle cx="4" cy="12.5" r="1.5" {...stroke} /><circle cx="12" cy="12.5" r="1.5" {...stroke} /><path d="M4 5v6M12 11V7a2 2 0 0 0-2-2H7m1.5-1.5L7 5l1.5 1.5" {...stroke} /></svg>,
  shield: <svg width="13" height="13" viewBox="0 0 16 16"><path d="M8 1.8 13 3.6v4.1c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5V3.6z" {...stroke} /></svg>,
  stop: <svg width="13" height="13" viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" {...stroke} /></svg>,
  moon: <svg width="13" height="13" viewBox="0 0 16 16"><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" {...stroke} /></svg>,
  user: <svg width="13" height="13" viewBox="0 0 16 16"><circle cx="8" cy="5.5" r="2.5" {...stroke} /><path d="M3 14c.6-2.8 2.6-4 5-4s4.4 1.2 5 4" {...stroke} /></svg>,
  chat: <svg width="13" height="13" viewBox="0 0 16 16"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" {...stroke} /></svg>,
  coin: <svg width="13" height="13" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" {...stroke} /><path d="M8 5v6M6.3 6.4c0-.8.7-1.2 1.7-1.2s1.7.5 1.7 1.2c0 1.8-3.4.9-3.4 2.8 0 .8.7 1.3 1.7 1.3s1.7-.5 1.7-1.3" {...stroke} /></svg>,
  key: <svg width="13" height="13" viewBox="0 0 16 16"><circle cx="5" cy="10.5" r="2.5" {...stroke} /><path d="M6.8 8.7 13 2.5M11 4.5l1.5 1.5" {...stroke} /></svg>,
  arrow: <svg width="13" height="13" viewBox="0 0 16 16"><path d="M3 11l4-4 2.5 2.5L13 6M13 6v3M13 6h-3" {...stroke} /></svg>,
  send: <svg width="13" height="13" viewBox="0 0 16 16"><path d="M14 2 2 7l5 2 2 5z" {...stroke} /></svg>,
}
