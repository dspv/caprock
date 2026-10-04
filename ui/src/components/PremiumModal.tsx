/**
 * What one paid feature is, what it costs, and the two ways to buy it.
 *
 * It opens when someone clicks a feature marked as paid — never on its own. A
 * dialog over your work is the loudest thing an interface can do, and this
 * product is a tool you installed, not a trial you are inside.
 *
 * **It shows the feature before it describes it.** The previous dialog was a
 * title, a paragraph and three grey bullets over two indigo buttons, and the
 * owner's verdict was that it was bad: nobody reads a paragraph to find out
 * what they would be buying. Now the first thing on it is a small picture of
 * the feature working, in the Week card's language — the cap stopping at its
 * line, the question asked about your own sessions, the Monday message. Every
 * figure in a picture is an example and carries an "Example" tag (rule 6).
 *
 * Then three short lines, the setup it demands named before payment (unnamed
 * work is what people discover after paying), and the price.
 *
 * **The price is the site's, exactly.** caprock.dev sells two shapes — $30 a
 * year and $100 once — and marks the lifetime as "Best value"; the monthly
 * price is deliberately not linked from anything (caprock-web
 * `src/content/pricing.ts`). The figures come from the daemon
 * (`GET /v1/premium`), compiled into the binary with a Go test that reads the
 * site's pricing file and fails when they disagree; nothing is fetched (rule
 * 4). The buttons are the product's own amber, primary and outline, like every
 * other control: the indigo set them apart as an advert.
 *
 * **No hedge, no comparison with Claude.** "Not built yet" in a bordered box
 * was the loudest element on the old screen; the refund term protects the
 * buyer instead. And pricing ourselves in months of Claude Pro argued against
 * us — readers said so four times in five.
 *
 * The honesty line — everything free stays free — stays, quieter, at the foot.
 * Both links open a new tab: nobody should lose the dashboard to read about a
 * subscription.
 */
import { api, type PremiumPricing } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { AgentCharacter } from './Characters'
import { Benefit, Icon, MiniCard, UpsellDialog } from './UpsellDialog'

export type PaidFeature = 'cap' | 'report' | 'gemini'

/**
 * `body` says what the feature is in one sentence; `points` say why you would
 * want it, each next to an icon.
 */
const FEATURES: Record<
  PaidFeature,
  { title: string; body: string; points: { icon: keyof typeof Icon; text: string }[]; setup?: string }
> = {
  cap: {
    title: 'A daily cap that pauses sessions',
    body: 'A number for the day. Cross it and Caprock stops its own sessions.',
    points: [
      { icon: 'stop', text: 'A runaway loop stops at your line, not hours later' },
      { icon: 'moon', text: 'It happens while you are asleep, not in tomorrow’s summary' },
      { icon: 'user', text: 'Sessions you started yourself are never touched' },
    ],
  },
  gemini: {
    title: 'Ask Gemini, on your own key',
    body: 'A second model inside Caprock, paid for by you, at Google’s prices.',
    points: [
      { icon: 'chat', text: 'Ask about your own sessions without leaving the dashboard' },
      { icon: 'coin', text: 'What it costs is counted beside your Claude spend' },
      { icon: 'key', text: 'Caprock never stores the key — it reads it from your environment' },
    ],
    // Named because it is the honest cost of not being a secret store.
    setup: 'Set GEMINI_API_KEY in the daemon’s environment and restart it. Google bills you directly.',
  },
  report: {
    title: 'A weekly report, sent where you are',
    body: 'Monday morning, before you open a terminal.',
    // What changed, not what happened: a digest of figures the dashboard
    // already shows is a notification, not a feature.
    points: [
      { icon: 'arrow', text: 'What moved — the repository that cost far more than its usual week' },
      { icon: 'stack', text: 'Last week against the one before, per repository and model' },
      { icon: 'send', text: 'Through your own Telegram bot — nothing passes our server' },
    ],
    setup: 'Setup: one message to BotFather, about two minutes.',
  },
}

/** The feature, drawn. Every figure is an example and the tag says so. */
function Picture({ feature }: { feature: PaidFeature }) {
  if (feature === 'cap') {
    return (
      <MiniCard label="Example: a $40 daily cap reached; the sessions Caprock started are paused, yours keep running">
        <p className="wk-eyebrow" style={{ fontSize: 11 }}>Today · daily cap</p>
        <p className="mt-1.5 flex items-baseline gap-2">
          <span className="font-mono text-[30px] font-bold leading-none tracking-[-0.03em] text-fg">$40.00</span>
          <span className="font-mono text-[12px] text-fg-muted">of a $40 cap</span>
        </p>
        <div className="relative mt-3 h-2.5 rounded-full bg-border-strong/60">
          <div className="absolute inset-y-0 left-0 w-full rounded-full bg-accent" />
          <div className="absolute -top-1 bottom-[-4px] right-0 w-[2px] bg-danger" />
        </div>
        <div className="mt-3 flex items-center gap-2.5">
          <AgentCharacter who="lead" size={34} />
          <p className="text-[12.5px] leading-snug text-fg">
            <span className="font-semibold">2 sessions Caprock started: paused.</span>
            <br />
            <span className="text-fg-muted">The one you opened in your terminal keeps running.</span>
          </p>
        </div>
      </MiniCard>
    )
  }
  if (feature === 'gemini') {
    return (
      <MiniCard label="Example: asking Gemini which repository cost the most this week, with the answer's cost beside the Claude spend">
        <div className="flex justify-end pt-6">
          <p className="max-w-[80%] rounded-[12px] rounded-br-[4px] bg-panel-2 px-3 py-1.5 text-[12.5px] text-fg">
            Which repository cost the most this week?
          </p>
        </div>
        <div className="mt-2 flex items-end gap-2">
          <AgentCharacter who="gemini" size={34} />
          <p className="max-w-[82%] rounded-[12px] rounded-bl-[4px] border border-border-strong px-3 py-1.5 text-[12.5px] leading-snug text-fg">
            <span className="font-semibold">acme-api</span>: <span className="text-accent">$212</span> of $466, most of it re-reading context.
          </p>
        </div>
        <p className="mt-2.5 flex flex-wrap gap-x-3 font-mono text-[11px] text-fg-muted">
          <span>this answer ≈$0.002 · your key</span>
          <span>Claude this week $466</span>
        </p>
      </MiniCard>
    )
  }
  return (
    <MiniCard label="Example: a Monday message from your own Telegram bot saying what moved last week">
      <p className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-fg-muted">
        <span className="text-accent">{Icon.send}</span> your bot · Monday morning
      </p>
      <p className="mt-2 text-[15px] font-semibold leading-snug text-fg">
        Last week <span className="text-accent">$466</span>, +38% on your usual week.
      </p>
      <ul className="mt-1.5 space-y-0.5 font-mono text-[12px] text-fg-muted">
        <li>▲ acme-api 3.1× its usual week</li>
        <li>▼ acme-web −40%</li>
        <li>Opus 91% · Codex 9%</li>
      </ul>
    </MiniCard>
  )
}

/**
 * The two ways to buy, as the site sells them: a year, or once. The lifetime
 * is the one the site marks "Best value", so it is the filled button.
 */
function Price({ p, onClose }: { p: PremiumPricing | undefined; onClose: () => void }) {
  if (!p) return <div className="h-[92px] text-[13px] text-fg-faint">…</div>
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <div className="flex flex-col rounded-[10px] border border-border-strong p-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-muted">Yearly</p>
        <a
          href={p.yearly.url}
          target="_blank"
          rel="noreferrer"
          onClick={onClose}
          className="mt-2 rounded-md border border-border-strong px-3 py-2 text-center text-[14px] font-medium text-fg no-underline hover:border-accent hover:text-accent"
        >
          ${p.yearly.charged_usd} / year
        </a>
        <p className="mt-1.5 text-center text-[11px] leading-snug text-fg-faint">Every Premium feature, renews yearly</p>
      </div>
      <div className="flex flex-col rounded-[10px] border border-accent bg-accent/[0.07] p-3">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-fg-muted">
          Once
          <span className="rounded-full bg-accent px-1.5 py-[1px] text-[10px] text-panel">Best value</span>
        </p>
        <a
          href={p.lifetime?.url}
          target="_blank"
          rel="noreferrer"
          onClick={onClose}
          className="mt-2 rounded-md bg-accent px-3 py-2 text-center text-[14px] font-semibold text-panel no-underline hover:bg-accent-strong"
        >
          ${p.lifetime?.charged_usd} once
        </a>
        <p className="mt-1.5 text-center text-[11px] leading-snug text-fg-faint">Every Premium feature, now and future — no renewal</p>
      </div>
    </div>
  )
}

export function PremiumModal({ feature, onClose }: { feature: PaidFeature; onClose: () => void }) {
  const pricing = useApi(() => api.premium(), [])
  const p = pricing.data
  const f = FEATURES[feature]
  return (
    <UpsellDialog
      label="Caprock Premium"
      eyebrow="Caprock Premium"
      title={f.title}
      onClose={onClose}
      picture={<Picture feature={feature} />}
      actions={<Price p={p} onClose={onClose} />}
      footer={
        <>
          <div className="flex items-center gap-3">
            <a href={p?.info_url ?? 'https://caprock.dev/premium/'} target="_blank" rel="noreferrer"
              className="whitespace-nowrap text-fg-muted no-underline hover:text-fg">
              Read more
            </a>
            <span className="whitespace-nowrap text-fg-faint">opens a new tab</span>
            <button type="button" onClick={onClose} className="ml-auto text-fg-muted hover:text-fg">Close</button>
          </div>
          <p className="mt-1.5 text-[10.5px] leading-snug text-fg-faint">
            Everything Caprock does now stays free and Apache-2.0 — Premium only ever adds.
          </p>
        </>
      }
    >
      <p className="text-[13.5px] leading-relaxed text-fg-muted">{f.body}</p>
      <ul className="mt-3 space-y-2">
        {f.points.map((pt) => <Benefit key={pt.text} icon={Icon[pt.icon]}>{pt.text}</Benefit>)}
      </ul>
      {f.setup && <p className="mt-3 rounded-md bg-panel-2 px-3 py-2 font-mono text-[11.5px] leading-snug text-fg-muted">{f.setup}</p>}
    </UpsellDialog>
  )
}
