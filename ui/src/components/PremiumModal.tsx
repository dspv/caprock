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
 * The price comes from the daemon (`GET /v1/premium`), not from a constant
 * here: a figure copied into the UI eventually contradicts the one that
 * charges the card. It is still compiled into the binary — rule 4 forbids
 * fetching it from anywhere — but there is one copy of it, in Go, with a test
 * that reads the site's pricing file and fails when the two disagree.
 *
 * Both buttons open a new tab. Nobody should lose the dashboard to read about
 * a subscription, and nobody should be dropped into a card form without having
 * been offered the longer explanation first.
 */
import { useEffect } from 'react'
import { api, type PremiumPricing } from '@/lib/api'
import { useApi } from '@/lib/useApi'

export type PaidFeature = 'cap' | 'report' | 'providers'

const FEATURES: Record<PaidFeature, { title: string; body: string; built: boolean }> = {
  cap: {
    title: 'A daily cap that pauses sessions',
    body: 'Set a number for the day. When the cost crosses it, Caprock pauses the sessions it started — while the spend is happening, not in a summary the next morning. Sessions you started yourself are never touched.',
    built: false,
  },
  report: {
    title: 'A weekly report, sent where you are',
    body: 'Where the week went, by repository and model, delivered to your own Telegram bot or webhook — your channel, not ours, which is the only way a tool that keeps your data local can reach you off the machine.',
    built: false,
  },
  providers: {
    title: 'Models from other providers',
    body: 'Run and observe sessions that do not go to Anthropic directly.',
    built: false,
  },
}

function Price({ p }: { p: PremiumPricing | undefined }) {
  if (!p) return <span className="text-fg-faint">…</span>
  return (
    <span className="text-fg">
      <span className="num text-[15px]">${p.yearly.per_month_usd.toFixed(2)}</span>
      <span className="text-fg-muted"> a month</span>
      <span className="text-fg-faint">
        {' '}— billed once a year at ${p.yearly.charged_usd}, ${p.monthly.charged_usd} monthly,
        {p.lifetime?.charged_usd ? ` or $${p.lifetime.charged_usd} once and never again.` : '.'}
      </span>
    </span>
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
        className="w-[480px] max-w-full rounded-[var(--radius-panel)] border border-border-strong bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center border-b border-border px-4 py-3">
          <h2 className="text-[13px] font-medium text-fg">{f.title}</h2>
          <button onClick={onClose} className="ml-auto text-fg-muted hover:text-fg" aria-label="Close">✕</button>
        </header>

        <div className="px-4 py-3 text-[13px]">
          <p className="leading-relaxed text-fg-muted">{f.body}</p>

          {/* Named as unbuilt, on the surface someone pays from. Selling ahead
            * of the build is a decision; letting someone find out afterwards
            * is not. */}
          {!f.built && (
            <p className="mt-3 rounded-sm border border-border bg-panel-2 px-2.5 py-1.5 text-[12px] text-fg-faint">
              Not built yet. Subscribing is what decides whether it gets built, and in which order.
            </p>
          )}

          <div className="mt-4 border-t border-border pt-3">
            <Price p={p} />
          </div>

          <p className="mt-3 text-[12px] leading-relaxed text-fg-faint">
            Everything Caprock does today stays free and Apache-2.0. Premium adds
            to that and never removes from it — and nothing about how you use it
            reaches us either way.
          </p>
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
          <a
            href={p?.yearly.url}
            target="_blank"
            rel="noreferrer"
            onClick={onClose}
            className={`rounded-sm border border-accent bg-accent/15 px-3 py-1 text-[13px] text-accent no-underline hover:bg-accent/25 ${p ? '' : 'pointer-events-none opacity-50'}`}
          >
            Subscribe
          </a>
          <a
            href={p?.info_url ?? 'https://caprock.dev/premium/'}
            target="_blank"
            rel="noreferrer"
            className="rounded-sm border border-border px-3 py-1 text-[13px] text-fg-muted no-underline hover:border-border-strong hover:text-fg"
          >
            Read more
          </a>
          <span className="text-[11px] text-fg-faint">both open a new tab</span>
          <button onClick={onClose} className="ml-auto text-[12px] text-fg-muted hover:text-fg">Close</button>
        </footer>
      </div>
    </div>
  )
}
