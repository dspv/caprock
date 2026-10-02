/**
 * What Caprock for Teams is, and why a team would pay for it — inside the
 * product, without leaving the dashboard.
 *
 * Owner request (2026-10-03): the only mention of the team version was a
 * footer link to the website, so someone looking at their own numbers had to
 * leave to find out what the team version even was. This answers the two
 * questions in place: what it is, and why it is worth paying for.
 *
 * The argument, in order:
 *
 *  - **This machine first.** When the caller has a measured figure, the
 *    dialog opens with it: the reader's own spend, across the projects it
 *    went to. A team has one of these per laptop, and that is the whole case.
 *  - **The questions a lead asks**, one line each, in the words of the team
 *    page, so what the dialog promises is what the page and the call show.
 *  - **Why pay**: one flat price for the team, in their own infrastructure,
 *    and the free version losing nothing.
 *
 * No figure for the price, for the same reason PremiumModal reads its price
 * from the daemon rather than a constant: a copy here would eventually
 * contradict the one on the pricing page. The flat-not-per-seat shape is the
 * part that persuades, and it does not change with the number.
 *
 * Rule 11: the team version is presented as the product. Nothing here says
 * pilot, coming soon or not built.
 */
import { useEffect } from 'react'
import { fmtUSD } from '@/lib/format'

const TEAMS = 'https://caprock.dev/teams'
const BOOK = 'https://caprock.dev/book/'
const PRICING = 'https://caprock.dev/pricing/'

export interface TeamsFact {
  costUSD: number
  projects: number
  /** How the window reads in a sentence: "in the last 30 days", "all time". */
  window: string
}

const QUESTIONS = [
  'Which repository and service is eating the budget',
  'Is anything running away right now — loops flagged on every machine',
  'Claude Code, Codex and the rest: one total, split by agent and model',
  'Monday morning: the week against the usual, and what drove it',
]

const WHY = [
  'One flat price for the whole team — never per seat, never a share of spend',
  'Runs on your infrastructure; prompts and code never leave a laptop',
  'Every developer keeps the free Caprock, with nothing taken away',
]

export function TeamsModal({ fact, onClose }: { fact?: TeamsFact; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const measured = !!fact && fact.costUSD > 0 && fact.projects > 0

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center bg-black/50 px-4 pt-[10vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Caprock for Teams"
    >
      <div
        className="w-[480px] max-w-full rounded-[var(--radius-panel)] border border-border-strong bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 px-5 pt-4">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-accent">Caprock for Teams</p>
            <h2 className="mt-1 text-[16px] font-medium leading-snug text-fg">
              This dashboard, across every laptop on your team
            </h2>
          </div>
          <button onClick={onClose} className="-mr-1 ml-auto text-fg-muted hover:text-fg" aria-label="Close">
            ✕
          </button>
        </header>

        <div className="px-5 pt-3">
          {measured && (
            /* The reader's own number, before any claim. */
            <p className="mb-3 rounded-sm border border-border bg-panel-2 px-3 py-2 text-[13px] leading-snug text-fg-muted">
              On this machine alone: <span className="num text-fg">{fmtUSD(fact!.costUSD)}</span> across{' '}
              <span className="num text-fg">{fact!.projects}</span> {fact!.projects === 1 ? 'project' : 'projects'}{' '}
              {fact!.window}. Your team has one of these on every laptop.
            </p>
          )}
          <p className="text-[13px] leading-relaxed text-fg-muted">
            Each developer keeps running Caprock. A collector on your own box adds the view across machines,
            and receives only counters: sessions, tokens and spend.
          </p>

          <p className="mt-3 text-[11px] uppercase tracking-wide text-fg-faint">The questions a lead asks, one screen each</p>
          <ul className="mt-1.5 space-y-1.5">
            {QUESTIONS.map((q) => (
              <li key={q} className="flex gap-2 text-[13px] leading-snug text-fg">
                <span aria-hidden className="text-accent">·</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-[11px] uppercase tracking-wide text-fg-faint">Why it is worth paying for</p>
          <ul className="mt-1.5 space-y-1.5">
            {WHY.map((w) => (
              <li key={w} className="flex gap-2 text-[13px] leading-snug text-fg">
                <span aria-hidden className="text-ok">✓</span>
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border px-5 py-4">
          <a
            href={BOOK}
            target="_blank"
            rel="noreferrer"
            onClick={onClose}
            className="rounded-sm bg-accent px-3 py-2.5 text-center text-[14px] font-medium text-bg no-underline hover:brightness-110"
          >
            Book a demo
          </a>
          <a
            href={TEAMS}
            target="_blank"
            rel="noreferrer"
            className="rounded-sm border border-border-strong px-3 py-2.5 text-center text-[14px] text-fg no-underline hover:bg-panel-2"
          >
            See the team page
          </a>
        </div>

        <footer className="flex items-center gap-3 border-t border-border px-5 py-3 text-[12px]">
          <a href={PRICING} target="_blank" rel="noreferrer" className="whitespace-nowrap text-fg-muted no-underline hover:text-fg">
            Pricing
          </a>
          <span className="whitespace-nowrap text-fg-faint">links open a new tab</span>
          <button onClick={onClose} className="ml-auto text-fg-muted hover:text-fg">
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}
