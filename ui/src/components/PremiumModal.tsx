/**
 * What Premium is, in one place, opened deliberately.
 *
 * The banner is one line, which is enough to be noticed and nowhere near
 * enough to explain what someone would be paying for. This is where the
 * explanation lives — but it opens only when a person clicks, never on its
 * own. A dialog that appears over someone's work is the loudest thing an
 * interface can do, and this product's whole argument is that it is a tool
 * you installed rather than a trial you are inside.
 *
 * So: quiet until asked, generous once asked.
 *
 * No prices here. They live on caprock.dev, in one file, next to the Stripe
 * links that must agree with them — a number copied into a second codebase is
 * a number that will eventually contradict the one that charges the card. The
 * button opens that page in a new tab, so nobody loses the dashboard to read
 * about a subscription.
 */
import { useEffect } from 'react'

const URL = 'https://caprock.dev/premium/'

/** In the release, and true the moment someone installs it. */
const WORKING = [
  ['Alerts before a plan window runs out', 'Warned at 90% of your 5-hour or 7-day window, with the reset time — rather than stopped mid-task by a limit you could have seen coming.'],
  ['Loop detection, with what it cost', 'When a session repeats the same call, the money it has burned doing it is attached to the alert.'],
  ['Sessions that went nowhere', 'Spent a lot, changed almost nothing — surfaced with the figures behind the judgement.'],
] as const

/** Not written yet. Saying so here is the same rule that governs a price. */
const PLANNED = [
  ['A daily cap that pauses sessions', 'When the day passes a number you set, Caprock stops the sessions it started. Never the ones you started yourself.'],
  ['A weekly report where you actually are', 'Where the week went, by repository and model, sent to your own Telegram bot or webhook — your channel, not ours.'],
  ['Models from other providers', 'Run and observe sessions that do not go to Anthropic directly.'],
] as const

export function PremiumModal({ onClose }: { onClose: () => void }) {
  // Escape closes it. A dialog that traps someone until they find the right
  // pixel is the kind of thing this component exists not to be.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center bg-black/50 px-4 pt-[10vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Caprock Premium"
    >
      <div
        className="w-[560px] max-w-full rounded-[var(--radius-panel)] border border-border-strong bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center border-b border-border px-4 py-3">
          <h2 className="text-[13px] font-medium text-fg">Caprock Premium</h2>
          <button onClick={onClose} className="ml-auto text-fg-muted hover:text-fg" aria-label="Close">✕</button>
        </header>

        <div className="px-4 py-3 text-[13px]">
          <p className="text-fg-muted leading-relaxed">
            Caprock shows you what every session is doing and what it costs.
            Premium is the half that acts on it.
          </p>

          <p className="mt-4 text-[11px] uppercase tracking-[0.08em] text-fg-faint">Working today</p>
          <ul className="mt-2 grid gap-2.5">
            {WORKING.map(([head, body]) => (
              <li key={head} className="border-l-2 border-accent/40 pl-3">
                <p className="text-fg">{head}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">{body}</p>
              </li>
            ))}
          </ul>

          {/* Named, and named as unbuilt. Selling ahead of the build is a
            * decision; letting someone find out afterwards is not. */}
          <p className="mt-5 text-[11px] uppercase tracking-[0.08em] text-fg-faint">Being built</p>
          <p className="mt-1 text-[12px] text-fg-faint">
            Not written yet — subscribing is what decides whether they get built.
          </p>
          <ul className="mt-2 grid gap-2.5">
            {PLANNED.map(([head, body]) => (
              <li key={head} className="border-l-2 border-border pl-3">
                <p className="text-fg">{head}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">{body}</p>
              </li>
            ))}
          </ul>

          <p className="mt-5 text-[12px] leading-relaxed text-fg-faint">
            Everything Caprock does today stays free and Apache-2.0. Premium adds
            to that and never removes from it — and nothing about how you use it
            reaches us either way.
          </p>
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
          <a
            href={URL}
            target="_blank"
            rel="noreferrer"
            onClick={onClose}
            className="rounded-sm border border-accent bg-accent/15 px-3 py-1 text-[13px] text-accent no-underline hover:bg-accent/25"
          >
            See the price and subscribe
          </a>
          <span className="text-[11px] text-fg-faint">opens caprock.dev in a new tab</span>
          <button onClick={onClose} className="ml-auto text-[12px] text-fg-muted hover:text-fg">Close</button>
        </footer>
      </div>
    </div>
  )
}
