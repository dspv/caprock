/**
 * The Second Brain screen's header strip (#/brain): is it building, how far,
 * at which step, and what it gives. The owner, 2026-10-15 (translated):
 * "Second Brain lacks indicators: whether it's building or not, N out of M,
 * no progress bar, no understanding of what exactly you're building; the
 * stage is unclear, where we are, what it gives, how much to use it, some
 * metrics."
 *
 * Every figure is a count from GET /v1/brain/status (03-contracts.md §
 * Second Brain), none estimated:
 *
 * - **State** — *Building · reading session 12 of 48* over a bar, *Up to
 *   date · last built 14:02*, *Paused*, *Off*, *Stopped* (no Claude Code) or
 *   *Waiting* (today's tokens used), each with why (lib/brain brainState).
 * - **Steps** — what one read does, in order: find finished sessions, Claude
 *   extracts memories, link them into the graph. The current step is lit;
 *   under it, the session being read (title, agent, project, passages sent,
 *   seconds so far). Up to date, all three are ticked.
 * - **What it gives** — how memories reach agents: a new session in a
 *   repository is handed up to five of its memories with the handoff, and
 *   how many sessions were (counted per session since migration 0058). With
 *   Memory between sessions off it says agents get nothing, and why.
 * - **Figures** — memories, new today, topics, links, the last 24 hours'
 *   tokens of the daily limit and what claude reported they cost at API list
 *   price.
 */
import { useState, type ReactNode } from 'react'
import { api, type BrainAutoStatus } from '@/lib/api'
import { BRAIN_STEPS, brainState, tokensShort } from '@/lib/brain'
import { fmtUSD } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { agentName } from '@/components/Characters'
import '@/components/BrainLive.css'

/** How many memories a new session is handed at most (internal/daemon handoffBrainMax). */
export const HANDOFF_MEMORIES = 5

/** Pause (off) and Resume (on again, the reach kept). */
export function PauseButton({ auto, onChanged }: { auto: BrainAutoStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const flip = () => {
    setBusy(true)
    api.brainSettings({ auto: !auto.on }).then(() => { setBusy(false); onChanged() }, () => { setBusy(false); onChanged() })
  }
  return (
    <button type="button" disabled={busy} onClick={flip} data-brain-pause
      className="rounded-[7px] border border-border px-2.5 py-1 text-[12.5px] text-fg-muted hover:border-border-strong hover:text-fg disabled:opacity-50">
      {auto.on ? 'Pause' : 'Resume'}
    </button>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function Figure({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="grid min-w-0 gap-0" title={title}>
      <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-muted">{label}</dt>
      <dd className="num text-[14px] leading-snug text-fg">{children}</dd>
    </div>
  )
}

export function BrainStrip({ auto, memories, onChanged, owner = true }: { auto: BrainAutoStatus; memories: number; onChanged: () => void; owner?: boolean }) {
  const now = useNow(1000)
  const s = brainState(auto, now)
  const b = auto.build
  const r = auto.reading
  const active = s.tone === 'active'
  const done = s.stage === 'up_to_date'
  // Which step is lit: between reads it is finding the next session.
  const at = s.stage === 'extracting' ? 1 : s.stage === 'linking' ? 2 : s.stage === 'waiting' ? 0 : -1
  const reach = auto.backfill_since && b && auto.backfill_since <= b.from + 1000
    ? `from the last ${Math.max(1, Math.round((now - b.from) / 86_400_000))} days`
    : 'since you turned it on'
  const stepFigure = [
    b ? `${b.sessions}${b.truncated ? '+' : ''} in reach · ${reach}` : '',
    b ? `${b.read} of ${b.sessions}${b.truncated ? '+' : ''} read` : '',
    `${plural(b?.memories ?? memories, 'memory', 'memories')} · ${plural(auto.topics ?? 0, 'topic', 'topics')} · ${plural(auto.links ?? 0, 'link', 'links')}`,
  ]
  const h = auto.handoff
  const pct = s.share === null ? null : Math.round(s.share * 100)
  return (
    <section className="grid gap-2.5 rounded-[12px] border border-border bg-panel px-4 py-3" aria-label="Second Brain status"
      data-brain-strip={active ? 'building' : 'idle'} data-brain-stage={s.stage}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`h-[9px] w-[9px] shrink-0 rounded-full ${active ? 'brain-live-dot bg-accent' : s.tone === 'calm' ? 'bg-accent/60' : s.tone === 'warn' ? 'bg-warn' : 'bg-fg-faint'}`} aria-hidden />
        <h2 className="text-[16px] font-semibold text-fg" data-brain-state>{s.word}</h2>
        <span className="min-w-0 text-[13.5px] text-fg-muted" data-brain-state-detail>· {s.detail}</span>
        <span className="ml-auto flex items-center gap-3">
          {pct !== null && <span className="num text-[12.5px] text-fg-muted" data-brain-pct>{pct}%</span>}
          {owner && <PauseButton auto={auto} onChanged={onChanged} />}
        </span>
      </div>
      {pct !== null && (
        <div role="progressbar" aria-label="Build progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
          className="h-[6px] overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-fg-muted)_18%,transparent)]" data-brain-strip-bar>
          <div className="brain-live-bar h-full rounded-full bg-accent transition-[width] duration-700 ease-out motion-reduce:transition-none" style={{ width: `${pct}%` }} />
        </div>
      )}

      <ol className="grid gap-2 sm:grid-cols-3" aria-label="How a session becomes memories" data-brain-steps>
        {BRAIN_STEPS.map((step, i) => {
          const state = done ? 'done' : at === i ? 'now' : at > i ? 'done' : 'idle'
          return (
            <li key={step.stage} className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 rounded-[9px] px-2.5 py-2 ${state === 'now' ? 'bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]' : ''}`}
              data-brain-step={step.stage} data-brain-step-state={state} aria-current={state === 'now' ? 'step' : undefined}>
              <span className={`mt-[1px] grid h-[18px] w-[18px] place-items-center rounded-full text-[11px] font-semibold ${
                state === 'now' ? 'bg-accent text-panel' : state === 'done' ? 'bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] text-accent' : 'border border-border text-fg-muted'}`} aria-hidden>
                {state === 'done' ? '✓' : i + 1}
              </span>
              <div className="grid min-w-0 gap-0.5">
                <span className={`text-[13px] ${state === 'now' ? 'font-semibold text-fg' : 'text-fg'}`}>{step.label}</span>
                {stepFigure[i] && <span className="num text-[12px] leading-snug text-fg-muted">{stepFigure[i]}</span>}
                {i === 1 && r && (
                  <span className="grid min-w-0 gap-0" data-brain-step-reading>
                    <span className="truncate text-[12.5px] text-fg" title={r.title}>{r.title || 'A session'}</span>
                    <span className="truncate text-[11.5px] text-fg-muted">
                      {[r.agent ? agentName(r.agent) : '', r.project, r.passages ? plural(r.passages, 'passage', 'passages') : '', `${Math.max(0, Math.round((now - r.started_at) / 1000))}s`].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      <p className="text-[13px] leading-snug text-fg" data-brain-gives>
        <span className="font-medium">What it gives: </span>
        {!h || h.on ? (
          <>
            a new session in a repository starts with up to {HANDOFF_MEMORIES} of its memories
            {h && (h.sessions > 0
              ? <span className="text-fg-muted"> — {plural(h.sessions_24h, 'session', 'sessions')} got {plural(h.memories_24h, 'memory', 'memories')} in the last 24 h, {h.sessions} in all</span>
              : <span className="text-fg-muted"> — none has yet; it happens when a session opens where there are memories</span>)}
            .
          </>
        ) : (
          <span className="text-fg-muted">nothing reaches your agents yet — Memory between sessions is off in Settings, and that is how a new session is handed its memories.</span>
        )}
      </p>

      <dl className="grid grid-cols-2 gap-x-5 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-6" data-brain-figures>
        <Figure label="Memories">{memories}</Figure>
        <Figure label="New today">{auto.new_today ?? 0}</Figure>
        <Figure label="Topics">{auto.topics ?? 0}</Figure>
        <Figure label="Links">{auto.links ?? 0}</Figure>
        <Figure label="Tokens, 24 h" title="What the reads used in the last 24 hours, of the daily limit">
          {tokensShort(auto.spent)} <span className="text-fg-muted">of {tokensShort(auto.daily_tokens)}</span>
        </Figure>
        <Figure label="Cost, 24 h" title="What Claude Code reported the reads cost, at API list price; on a subscription it comes out of your plan's limits instead">
          {fmtUSD(auto.spent_usd ?? 0)} <span className="text-[11.5px] text-fg-muted">API list price</span>
        </Figure>
      </dl>
    </section>
  )
}
