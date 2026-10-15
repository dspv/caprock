/**
 * "How it works" for Second Brain (ADR-063), opened from the sidebar's Second
 * Brain block. Big and short (the owner, 2026-10-15, translated: "big,
 * short, clear"): the agents this user runs feeding the brain made of a
 * graph (BrainHero, components/BrainAgents), *Free* by the title, the
 * headline, a sub-line naming those agents, three steps of one line each,
 * the long-term promise ("your personal Jarvis", the owner's idea) in one
 * line, that it is free and local in one line, and the one action. It fits
 * without scrolling at 800px tall.
 *
 * The numbers live in *Details*, folded, not in the main read. They are the
 * daemon's defaults (internal/brain/engine.go: DefaultModel "haiku",
 * DefaultDailyTokens 300,000), and the handoff takes up to five of a
 * repository's memories (ADR-063). Change them together. "This computer",
 * not "this Mac": the dialog ships on all three OSes.
 *
 * Second Brain is free (owner decision, 2026-10-14), and the dialog says so
 * plainly (owner, 2026-10-15). There is nothing to buy here; the action
 * opens the Brain screen. Nothing here sends anything. The
 * ×, Escape and the backdrop close it; there is no second Close.
 */
import type { ReactNode } from 'react'
import { agentsLine, BRAIN_HEADLINE, BrainHero, FreePill, useAgentsUsed } from './BrainAgents'
import { CloseButton, DialogBackdrop } from './Dialog'
import { useDialogFocus } from './UpsellDialog'

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

const STEPS: [ReactNode, string][] = [
  [<svg width="15" height="15" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.5" {...stroke} /><path d="M5 7l2 1.5L5 10M8.5 10.5h2.5" {...stroke} /></svg>, 'Sessions end'],
  [<svg width="15" height="15" viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="7.5" rx="1.2" {...stroke} /><path d="M5.5 13.5h5M8 10.5v3" {...stroke} /></svg>, 'Your Claude reads them, on this computer'],
  [<svg width="15" height="15" viewBox="0 0 16 16"><path d="M8 1.8l1.6 4.1 4.1 1.6-4.1 1.6L8 13.2 6.4 9.1 2.3 7.5l4.1-1.6z" {...stroke} /></svg>, 'The next agent starts smarter'],
]

export function SecondBrainModal({ onClose, onOpen }: { onClose: () => void; onOpen?: () => void }) {
  const panel = useDialogFocus()
  const agents = useAgentsUsed()
  return (
    <DialogBackdrop
      onClose={onClose}
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/55 px-3 py-[5vh] sm:px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Second Brain"
    >
      <div
        ref={panel}
        className="relative w-[480px] max-w-full overflow-hidden rounded-[16px] border border-border-strong bg-panel px-6 pb-5 pt-5 text-center shadow-[var(--shadow-panel)]"
        onClick={(e) => e.stopPropagation()}
      >
        <CloseButton onClick={onClose} className="absolute right-3 top-3" />
        <BrainHero agents={agents} className="mx-auto h-auto w-[400px] max-w-full" />
        <FreePill className="mt-3 h-[22px] px-2.5 text-[12.5px]" />
        <h2 className="mt-2 text-[26px] font-semibold leading-tight tracking-[-0.02em] text-fg">{BRAIN_HEADLINE}</h2>
        <p className="mt-1.5 text-[14px] leading-snug text-fg-muted" data-brain-agents-line>{agentsLine(agents)}</p>
        <ol className="mx-auto mt-4 grid max-w-[340px] gap-2 text-left text-[14px] text-fg" aria-label="How it works">
          {STEPS.map(([icon, text]) => (
            <li key={text} className="flex items-center gap-2.5">
              <span aria-hidden className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-accent/12 text-accent">{icon}</span>
              <span>{text}</span>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-[15px] font-medium text-accent" data-brain-jarvis>Over time: your personal Jarvis.</p>
        <p className="mt-1 text-[12.5px] text-fg-muted" data-brain-privacy>Free — runs on your own Claude, on this computer.</p>
        <button type="button" onClick={() => { onOpen?.(); onClose() }}
          className="mt-4 w-full rounded-lg bg-accent px-3 py-2.5 text-[14.5px] font-semibold text-panel hover:bg-accent-strong">
          {onOpen ? 'Open Second Brain' : 'Got it'}
        </button>
        <details className="mt-3 text-left text-[12px] leading-snug text-fg-muted" data-brain-details>
          <summary className="cursor-pointer select-none text-center text-fg-faint hover:text-fg">Details</summary>
          <ul className="mt-2 grid list-disc gap-1 pl-4">
            <li>Once you turn it on, each session that finishes, or goes quiet for ten minutes, is read.</li>
            <li>Your own <span className="mono">claude</span> reads it with Haiku, up to 300k tokens a day by default; change either, or turn it off, in Settings → Second Brain.</li>
            <li>It keeps decisions, findings, ideas and open questions; up to five of a project’s memories go into the handoff of the next session you start there.</li>
            <li>Nothing leaves your computer except the call your own <span className="mono">claude</span> makes.</li>
          </ul>
        </details>
      </div>
    </DialogBackdrop>
  )
}
