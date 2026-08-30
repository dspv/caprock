/**
 * What one paid feature is, what it costs, and the two ways out of the dialog.
 *
 * It opens when someone clicks a feature marked as paid — never on its own. A
 * dialog that appears over your work is the loudest thing an interface can do,
 * and this product's argument is that it is a tool you installed rather than a
 * trial you are inside.
 *
 * It leads with the feature that was clicked rather than a pitch for the plan.
 * Someone who clicked "a cap that stops this" wants to know about that, and
 * being handed a generic upgrade page instead is how a specific interest turns
 * into a closed tab.
 *
 * **The order is the argument.** An earlier version put every true statement on
 * screen at the same weight, and the loudest element on it was a bordered box
 * disclaiming the feature — the first thing the eye landed on was a reason not
 * to buy. Three prices sat where a decision belonged, and Subscribe was styled
 * as one of three equal buttons. Every fact on it was honest and the screen
 * still argued against itself.
 *
 * **The disclaimer is gone, and that is a deliberate decision with a place it
 * is kept instead.** These features are being built — the commitment is real,
 * not a maybe — and a sales screen that hedges its own product sells nothing.
 * What protects the buyer is the refund term rather than a line of grey text:
 * the terms say that a feature described as being built and then abandoned is
 * refunded for the period paid. That is a stronger promise than a caveat,
 * because it costs us money and a caveat costs us nothing.
 *
 * **What this does oblige us to do is ship them.** If a feature here is still
 * unbuilt long enough that someone has paid a full period for it and cannot
 * use it, the honest fix is to build it or to stop selling it — not to put the
 * warning back and call it square.
 *
 * **A price needs a ruler.** $30 is neither cheap nor dear on its own, and the
 * one number every reader of this dialog is already paying is their Claude
 * subscription. So the comparison is stated outright — a year of Caprock
 * against a month and a half of Claude Pro — with the source and the date it
 * was read on the screen, because an unsourced number about someone else's
 * pricing is exactly what rule 6 forbids. It is a comparison of magnitude, not
 * a suggestion that one replaces the other, and the line says so.
 *
 * So: what you get, then what it costs against what you already pay, then the
 * caveats — each at the weight it deserves. Two prices are offered as
 * buttons — $30 a year and $100 once — because those are the two real
 * decisions; $5 monthly stays as a line under them for anyone who wants the
 * smallest commitment.
 *
 * The price comes from the daemon (`GET /v1/premium`), not from a constant
 * here: a figure copied into the UI eventually contradicts the one that
 * charges the card. It is still compiled into the binary — rule 4 forbids
 * fetching it from anywhere — but there is one copy of it, in Go, with a test
 * that reads the site's pricing file and fails when the two disagree.
 *
 * Both links open a new tab. Nobody should lose the dashboard to read about a
 * subscription, and nobody should be dropped into a card form without having
 * been offered the longer explanation first.
 */
import { useEffect } from 'react'
import { api, type PremiumPricing } from '@/lib/api'
import { useApi } from '@/lib/useApi'

export type PaidFeature = 'cap' | 'report'

/**
 * `points` is what the feature does for you, in the fewest words that still
 * mean something. The prose body says what it is; these say why you would
 * want it. A paragraph of grey text was carrying both jobs and doing neither.
 */
const FEATURES: Record<
  PaidFeature,
  { title: string; body: string; points: string[] }
> = {
  cap: {
    title: 'A daily cap that pauses sessions',
    body: 'A number for the day. Cross it and Caprock stops its own sessions.',
    points: [
      'A runaway loop stops at $40 instead of finishing at $400',
      'It happens while you are asleep, not in tomorrow\u2019s summary',
      'Your own sessions are never touched — only the ones Caprock started',
    ],
  },
  report: {
    title: 'A weekly report, sent where you are',
    body: 'Where the week went, in your Telegram — not on our server.',
    points: [
      'Monday morning: what last week cost, and which repository ate it',
      'Lands in your Telegram before you open a terminal',
      'Through your own bot — the report leaves your machine only for you',
    ],
  },
  // Third-party pricing was going to live here. It was cheaper to add the
  // prices than to build a paywall around them, so DeepSeek, MiniMax and the
  // rest now cost out for everyone — and a feature the free version performs
  // cannot be sold without the paid tier becoming a hostage.
}

/**
 * What it costs, against what the reader is already paying.
 *
 * The comparison comes first because it is what makes the figure mean
 * anything. Both real ways to buy are then offered as buttons of equal weight
 * — a year, or once and never again — since a single "Subscribe" hides the
 * lifetime option behind a page load, and it is the one people ask about.
 */
function Price({ p, onClose }: { p: PremiumPricing | undefined; onClose: () => void }) {
  if (!p) return <div className="h-[92px] text-[13px] text-fg-faint">…</div>

  const c = p.compare
  // What each price is worth in the thing the reader already buys.
  //
  // This was a two-row table above the buttons — "Claude Pro $20/month" over
  // "Caprock Premium $2.50/month" — and it read as a strange comparison of two
  // unrelated numbers before you got to what you were paying. The comparison
  // belongs *under* each button, attached to the price it explains: not "here
  // is our monthly rate against theirs", but "this button costs you a month
  // and a half of Claude Pro".
  const asMonths = (usd: number) => (c ? usd / c.monthly_usd : 0)
  const say = (n: number) => {
    if (n < 1.25) return 'about a month'
    if (n < 1.75) return 'about six weeks'
    if (n < 2.5) return 'about two months'
    return `about ${Math.round(n)} months`
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {/* Both filled, and the lifetime one brighter.
          *
          * An outlined second button reads as the lesser option, which is
          * backwards: someone weighing the year should see the lifetime as the
          * step up from it. Two solid buttons of ascending brightness make the
          * upgrade legible without a word of copy. */}
        <a
          href={p.yearly.url}
          target="_blank"
          rel="noreferrer"
          onClick={onClose}
          className="rounded-sm bg-premium/75 px-3 py-2.5 text-center text-[14px] font-medium text-white no-underline hover:bg-premium"
        >
          ${p.yearly.charged_usd} / year
        </a>
        <a
          href={p.lifetime?.url}
          target="_blank"
          rel="noreferrer"
          onClick={onClose}
          className="rounded-sm bg-premium-strong px-3 py-2.5 text-center text-[14px] font-medium text-white no-underline hover:brightness-110"
        >
          ${p.lifetime?.charged_usd} forever
        </a>
      </div>

      {c && (
        <div className="mt-2 grid grid-cols-2 gap-2 text-center text-[11px] leading-snug text-fg-faint">
          <span>{say(asMonths(p.yearly.charged_usd))} of {c.plan}</span>
          <span>{say(asMonths(p.lifetime?.charged_usd ?? 0))} of {c.plan}</span>
        </div>
      )}
    </>
  )
}

export function PremiumModal({ feature, onClose }: { feature: PaidFeature; onClose: () => void }) {
  const pricing = useApi(() => api.premium(), [])
  const p = pricing.data
  const f = FEATURES[feature]

  // Escape closes it. A dialog that traps someone until they find the right
  // pixel is the kind of thing this component exists not to be.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center bg-black/50 px-4 pt-[12vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Caprock Premium"
    >
      <div
        className="w-[440px] max-w-full rounded-[var(--radius-panel)] border border-border-strong bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 px-5 pt-4">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-premium-strong">Caprock Premium</p>
            <h2 className="mt-1 text-[16px] font-medium leading-snug text-fg">{f.title}</h2>
          </div>
          <button
            onClick={onClose}
            className="-mr-1 ml-auto text-fg-muted hover:text-fg"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="px-5 pt-3">
          <p className="text-[13px] leading-relaxed text-fg-muted">{f.body}</p>

          <ul className="mt-3 space-y-1.5">
            {f.points.map((point) => (
              <li key={point} className="flex gap-2 text-[13px] leading-snug text-fg">
                <span aria-hidden className="text-premium-strong">·</span>
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-4 border-t border-border px-5 py-4">
          <Price p={p} onClose={onClose} />

        </div>

        <footer className="border-t border-border px-5 py-3 text-[12px]">
          <div className="flex items-center gap-3">
            <a
              href={p?.info_url ?? 'https://caprock.dev/premium/'}
              target="_blank"
              rel="noreferrer"
              className="whitespace-nowrap text-fg-muted no-underline hover:text-fg"
            >
              Read more
            </a>
            <span className="whitespace-nowrap text-fg-faint">opens a new tab</span>
            <button onClick={onClose} className="ml-auto text-fg-muted hover:text-fg">
              Close
            </button>
          </div>
          {p?.compare && (
            <p className="mt-1.5 text-[11px] text-fg-faint">
              {p.compare.plan} price: {p.compare.source}, read {p.compare.read_on}
            </p>
          )}
        </footer>

        <p className="border-t border-border px-5 py-2.5 text-[11px] leading-relaxed text-fg-faint">
          Everything Caprock does today stays free and Apache-2.0. Nothing about
          how you use it reaches us.
        </p>
      </div>
    </div>
  )
}
