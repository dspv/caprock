/**
 * The Second Brain screen's status line (#/brain): one line on top that says
 * whether it is building and what it holds, with the rest one click away.
 * The owner, 2026-10-16 (translated): "much better already but it's unclear
 * what to do with it" — so the three step blocks and the six tiles that led
 * the screen became this line, and the screen leads with what a new session
 * gets (BrainNext).
 *
 * Every figure is a count from GET /v1/brain/status (03-contracts.md §
 * Second Brain), none estimated:
 *
 * - **The line** — *Up to date · 278 memories · 137 new today · 91 topics ·
 *   $0.15 in 24 h* (when it last built in its tooltip); while it builds,
 *   *Building · reading session 13 of 41 · 29%* over a 6px bar, the memories
 *   so far after it (lib/brain brainState). *Paused*, *Off*, *Stopped* (no
 *   Claude Code) and *Waiting* (today's tokens used) say why.
 * - **Details** (folded): the session being read (title, agent, project,
 *   passages, seconds), what one read does and where it is, the links, the
 *   last 24 hours' tokens of the daily limit and their cost at API list
 *   price, when it last built; while it builds, where the sessions come from
 *   (per project) and the last three reads.
 * - **A problem** is said under the line with the one action that fixes it:
 *   no claude → *Check again*; today's limit used → *Raise to 1M a day*; a
 *   failed read → that it is tried again on its own.
 */
import { useState, type ReactNode } from 'react'
import { api, errText, type BrainAutoStatus } from '@/lib/api'
import { BRAIN_STEPS, brainState, buildFigures, clockOrDay, isBuilding, tokensShort } from '@/lib/brain'
import { fmtAgo, fmtUSD } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { agentName } from '@/components/Characters'
import '@/components/BrainLive.css'

/** How many memories a new session is handed at most (store.BrainHandoffMax). */
export const HANDOFF_MEMORIES = 5

const ONE_MILLION = 1_000_000

/** Pause (off) and Resume (on again, the reach kept). */
export function PauseButton({ auto, onChanged }: { auto: BrainAutoStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const flip = () => {
    setBusy(true)
    api.brainSettings({ auto: !auto.on }).then(() => { setBusy(false); onChanged() }, () => { setBusy(false); onChanged() })
  }
  return (
    <button type="button" disabled={busy} onClick={flip} data-brain-pause
      className="rounded-[7px] border border-border px-2 py-0.5 text-[12px] text-fg-muted hover:border-border-strong hover:text-fg disabled:opacity-50">
      {auto.on ? 'Pause' : 'Resume'}
    </button>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function Bar({ share, label, className = '' }: { share: number; label: string; className?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, share)) * 100)
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
      className={`h-[6px] overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-fg-muted)_18%,transparent)] ${className}`}>
      <div className="brain-live-bar h-full rounded-full bg-accent transition-[width] duration-700 ease-out motion-reduce:transition-none" style={{ width: `${pct}%` }} />
    </div>
  )
}

/** The one thing wrong, in words, with the one action that fixes it. */
function Problem({ auto, onChanged }: { auto: BrainAutoStatus; onChanged: () => void }) {
  const [err, setErr] = useState('')
  const raise = () => {
    setErr('')
    api.brainSettings({ daily_tokens: ONE_MILLION }).then(onChanged, (e: unknown) => setErr(errText(e)))
  }
  let text = ''
  let action: ReactNode = null
  if (!auto.claude_found) {
    text = 'Claude Code was not found on this computer, so nothing can be read. Install it, then check again.'
    action = <button type="button" onClick={onChanged} className="brain-live-fix">Check again</button>
  } else if (auto.on && auto.spent >= auto.daily_tokens) {
    text = `Today’s ${tokensShort(auto.daily_tokens)} tokens are used. Reading goes on as the day rolls over.`
    if (auto.daily_tokens < ONE_MILLION) action = <button type="button" onClick={raise} className="brain-live-fix">Raise to 1M a day</button>
  } else if (auto.last_error && isBuilding(auto)) {
    text = `The last read failed: ${auto.last_error}. It is tried again on its own.`
  }
  if (!text) return null
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[10px] border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[13.5px] leading-snug text-fg" data-brain-problem>
      <span className="min-w-0 flex-1">{text}</span>
      {action}
      {err && <span className="w-full text-danger">{err}</span>}
    </div>
  )
}

function Fact({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="grid min-w-0 gap-0" title={title}>
      <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-muted">{label}</dt>
      <dd className="num text-[13px] leading-snug text-fg">{children}</dd>
    </div>
  )
}

export function BrainStrip({ auto, memories, onChanged, owner = true }: { auto: BrainAutoStatus; memories: number; onChanged: () => void; owner?: boolean }) {
  const now = useNow(1000)
  const [open, setOpen] = useState(false)
  const s = brainState(auto, now)
  const b = auto.build
  const r = auto.reading
  const f = buildFigures(auto, now)
  const active = s.tone === 'active'
  const done = s.stage === 'up_to_date'
  const pct = s.share === null ? null : Math.round(s.share * 100)
  // Which step a read is at: between reads it is finding the next session.
  const at = s.stage === 'extracting' ? 1 : s.stage === 'linking' ? 2 : s.stage === 'waiting' ? 0 : -1
  // Up to date, the line is what it holds; otherwise what it is doing, then
  // how many it holds.
  const parts: ReactNode[] = done
    ? [
        plural(memories, 'memory', 'memories'),
        `${auto.new_today ?? 0} new today`,
        plural(auto.topics ?? 0, 'topic', 'topics'),
        <span key="cost" title="What Claude Code reported the reads cost in the last 24 hours, at API list price; on a subscription it comes out of your plan's limits instead">{fmtUSD(auto.spent_usd ?? 0)} in 24 h</span>,
      ]
    : [s.detail, ...(pct !== null ? [`${pct}%`] : []), plural(b?.memories ?? memories, 'memory', 'memories')]
  const recent = auto.recent.slice(0, 3)
  return (
    <section className="grid gap-2" aria-label="Second Brain status" data-brain-strip={active ? 'building' : 'idle'} data-brain-stage={s.stage}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px]">
        <span className={`h-[8px] w-[8px] shrink-0 rounded-full ${active ? 'brain-live-dot bg-accent' : s.tone === 'calm' ? 'bg-accent/60' : s.tone === 'warn' ? 'bg-warn' : 'bg-fg-faint'}`} aria-hidden />
        {/* One flow of text, so a narrow screen wraps it between figures, not after the word. */}
        <div className="min-w-0 flex-1 leading-snug">
          <h2 className="inline text-[13.5px] font-semibold text-fg" data-brain-state
            title={done && auto.last_read ? `Last built ${clockOrDay(auto.last_read, now)}` : undefined}>{s.word}</h2>
          <span className="text-fg-muted" data-brain-state-detail>
            {/* The space before each dot is where a line may break; a short figure stays whole. */}
            {parts.map((p, i) => <span key={i}>{' '}<span className={typeof p === 'string' && p.length > 28 ? '' : 'whitespace-nowrap'}>· {p}</span></span>)}
          </span>
        </div>
        <span className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="brain-status-details" data-brain-details-toggle
            className="inline-flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[12px] text-fg-muted hover:bg-panel-2 hover:text-fg">
            Details
            <svg aria-hidden viewBox="0 0 12 12" className={`h-[10px] w-[10px] transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 4.5 6 7.5 9 4.5" /></svg>
          </button>
          {owner && <PauseButton auto={auto} onChanged={onChanged} />}
        </span>
      </div>
      {pct !== null && <Bar share={pct / 100} label="Build progress" />}

      <Problem auto={auto} onChanged={onChanged} />

      {open && (
        <div id="brain-status-details" className="grid gap-3 rounded-[10px] border border-border bg-panel px-3.5 py-3" data-brain-details>
          {r && (
            <p className="grid min-w-0 gap-0 text-[12.5px]" data-brain-step-reading>
              <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-muted">Reading now</span>
              <span className="truncate text-fg" title={r.title}>{r.title || 'A session'}</span>
              <span className="truncate text-[11.5px] text-fg-muted">
                {[r.agent ? agentName(r.agent) : '', r.project, r.passages ? plural(r.passages, 'passage', 'passages') : '', `${Math.max(0, Math.round((now - r.started_at) / 1000))}s`].filter(Boolean).join(' · ')}
              </span>
            </p>
          )}
          <ol className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]" aria-label="How a session becomes memories" data-brain-steps>
            {BRAIN_STEPS.map((step, i) => {
              const state = done ? 'done' : at === i ? 'now' : at > i ? 'done' : 'idle'
              return (
                <li key={step.stage} data-brain-step={step.stage} data-brain-step-state={state} aria-current={state === 'now' ? 'step' : undefined}
                  className={state === 'now' ? 'font-semibold text-fg' : state === 'done' ? 'text-fg' : 'text-fg-muted'}>
                  <span aria-hidden className={state === 'idle' ? 'text-fg-faint' : 'text-accent'}>{state === 'done' ? '✓' : `${i + 1}.`}</span> {step.label}
                </li>
              )
            })}
          </ol>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-4" data-brain-figures>
            {b && <Fact label="Sessions">{b.read} of {b.sessions}{b.truncated ? '+' : ''} read{f?.days ? ` · last ${f.days} days` : ''}</Fact>}
            <Fact label="Links">{auto.links ?? 0}</Fact>
            <Fact label="Tokens, 24 h" title="What the reads used in the last 24 hours, of the daily limit">
              {tokensShort(auto.spent)} <span className="text-fg-muted">of {tokensShort(auto.daily_tokens)}</span>
            </Fact>
            <Fact label="Cost, 24 h" title="What Claude Code reported the reads cost, at API list price; on a subscription it comes out of your plan's limits instead">
              {fmtUSD(auto.spent_usd ?? 0)} <span className="text-[11.5px] text-fg-muted">API list price</span>
            </Fact>
            {auto.last_read ? <Fact label="Last built">{clockOrDay(auto.last_read, now)}</Fact> : null}
          </dl>
          {isBuilding(auto) && (f?.sources.length ?? 0) > 0 && (
            <div className="grid gap-1.5" data-brain-sources>
              <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-muted">Where it comes from</h3>
              <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-3">
                {f!.sources.map((src) => (
                  <li key={src.project || '-'} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1" data-brain-source={src.project}>
                    <span className="truncate text-[13px] text-fg" title={src.project}>{src.project || 'No project'}</span>
                    <span className="text-[12px] text-fg-muted">
                      {src.read} of {src.read + src.pending} read · <span className="text-fg">{src.memories}</span> {src.memories === 1 ? 'memory' : 'memories'}
                    </span>
                    <Bar share={src.read + src.pending ? src.read / (src.read + src.pending) : 1} label={`${src.project || 'No project'}: sessions read`} className="col-span-2 h-[3px]" />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {recent.length > 0 && (
            <div className="grid gap-1" data-brain-recent>
              <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-muted">Just read</h3>
              <ul className="grid gap-0.5 text-[12.5px]">
                {recent.map((run) => (
                  <li key={run.id} className="flex min-w-0 items-baseline gap-2">
                    <span className={`shrink-0 ${run.status === 'failed' ? 'text-warn' : 'text-accent'}`} aria-hidden>{run.status === 'failed' ? '!' : '✓'}</span>
                    <span className="min-w-0 truncate text-fg">{run.title || run.project || run.session_id.slice(0, 8)}</span>
                    <span className="shrink-0 text-fg-muted">
                      {run.project && run.title ? `${run.project} · ` : ''}
                      {run.status === 'ok' ? plural(run.nodes, 'memory', 'memories') : run.status === 'failed' ? 'failed, will retry' : 'too short'}
                      {' · '}{fmtAgo(run.finished_at, now)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
