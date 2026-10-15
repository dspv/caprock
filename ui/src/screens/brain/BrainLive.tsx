/**
 * Second Brain being built, as it happens (#/brain, ADR-063). The owner,
 * 2026-10-15 (translated): "something is being computed, something is being
 * built, show where the data comes from … it must feel ACTIVE".
 *
 * Everything here is GET /v1/brain/status as it is (03-contracts.md § Second
 * Brain), read again on every `brain` frame — a read beginning or ending
 * sends one with op `progress` — and every few seconds while it builds
 * (lib/brain useBrainStatus):
 *
 * - **Reading now** — `auto.reading`: the session's title, agent, project,
 *   when it ran, and for how long it has been read.
 * - **Sessions** — `auto.build`: read of all in reach, "from the last 30
 *   days", with a bar.
 * - **Memories found** — the build's count, ticking up as reads land.
 * - **Today** — `spent` of `daily_tokens`, with a bar.
 * - **Where it comes from** — `build.sources`: each project, sessions read
 *   and waiting, memories kept.
 * - **Just read** — `recent`, the last three reads.
 *
 * A problem is said plainly with the one action that fixes it: no claude →
 * *Check again*; today's limit used → *Raise to 1M a day*; a failed read →
 * that it retries on its own. *Pause* is the small secondary control (it
 * turns the extraction off; *Resume* turns it on and carries on where it
 * stopped, the backfill's reach kept).
 *
 * Beside the figures turns the living brain (components/BrainOrb), the one
 * the sidebar card draws: sparks fly from the agents into it while it
 * reads, and a point lights up as each memory lands.
 *
 * Not building and up to date, it is one quiet line (BrainLiveLine).
 */
import { useEffect, useRef, useState } from 'react'
import { api, errText, type BrainAutoStatus } from '@/lib/api'
import { brainActivity, buildFigures, isBuilding, tokensShort, useBrainLanded } from '@/lib/brain'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { agentName } from '@/components/Characters'
import { useAgentsUsed } from '@/components/BrainAgents'
import { BrainOrb } from '@/components/BrainOrb'
import '@/components/BrainLive.css'

const ONE_MILLION = 1_000_000

/** A number that counts up to its new value instead of jumping (held still under reduced motion). */
export function Ticker({ value, className = '' }: { value: number; className?: string }) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    const start = from.current
    from.current = value
    let still = false
    try { still = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { /* old browser */ }
    if (still || start === value || typeof window.requestAnimationFrame !== 'function') { setShown(value); return }
    const t0 = performance.now()
    let id = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 700)
      setShown(Math.round(start + (value - start) * (1 - (1 - k) ** 3)))
      if (k < 1) id = window.requestAnimationFrame(step)
    }
    id = window.requestAnimationFrame(step)
    return () => window.cancelAnimationFrame(id)
  }, [value])
  return <span className={`num ${className}`}>{shown}</span>
}

function Bar({ share, label, className = '' }: { share: number; label: string; className?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, share)) * 100)
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
      className={`h-[6px] overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-fg-muted)_18%,transparent)] ${className}`}>
      <div className="brain-live-bar h-full rounded-full bg-accent transition-[width] duration-700 ease-out motion-reduce:transition-none" style={{ width: `${pct}%` }} />
    </div>
  )
}

function Card({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`grid min-w-0 content-start gap-1 rounded-[10px] border border-border bg-panel px-3.5 py-3 ${className}`}>
      <span className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-fg-muted">{label}</span>
      {children}
    </div>
  )
}

/** Pause (off) and Resume (on again, the reach kept). */
function PauseButton({ auto, onChanged }: { auto: BrainAutoStatus; onChanged: () => void }) {
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

/** The one thing wrong, in words, with the one action that fixes it. */
function Problem({ auto, onChanged }: { auto: BrainAutoStatus; onChanged: () => void }) {
  const [err, setErr] = useState('')
  const raise = () => {
    setErr('')
    api.brainSettings({ daily_tokens: ONE_MILLION }).then(onChanged, (e: unknown) => setErr(errText(e)))
  }
  let text = ''
  let action: React.ReactNode = null
  if (!auto.claude_found) {
    text = 'Claude Code was not found on this computer, so nothing can be read. Install it, then check again.'
    action = <button type="button" onClick={onChanged} className="brain-live-fix">Check again</button>
  } else if (auto.spent >= auto.daily_tokens) {
    text = `Today’s ${tokensShort(auto.daily_tokens)} tokens are used. Reading goes on as the day rolls over.`
    if (auto.daily_tokens < ONE_MILLION) action = <button type="button" onClick={raise} className="brain-live-fix">Raise to 1M a day</button>
  } else if (auto.last_error) {
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

export function BrainLive({ auto, onChanged, kinds, count }: { auto: BrainAutoStatus; onChanged: () => void; kinds: string[]; count: number }) {
  const now = useNow(1000)
  const agents = useAgentsUsed()
  const landed = useBrainLanded()
  const f = buildFigures(auto, now)
  const building = isBuilding(auto)
  const r = auto.reading
  const reach = f?.days ? `from the last ${f.days} days` : 'since you turned it on'
  const spentShare = auto.daily_tokens > 0 ? auto.spent / auto.daily_tokens : 0
  const recent = auto.recent.slice(0, 3)
  const nextIn = auto.next_wake && auto.next_wake > now ? Math.ceil((auto.next_wake - now) / 1000) : 0
  return (
    <section className="grid gap-3" aria-label="Building Second Brain" data-brain-live={building ? 'building' : 'idle'}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`h-[9px] w-[9px] shrink-0 rounded-full ${building ? 'brain-live-dot bg-accent' : 'bg-fg-faint'}`} aria-hidden />
        <h2 className="text-[16px] font-semibold text-fg">
          {!auto.on ? 'Paused' : building ? 'Building your Second Brain' : 'Up to date'}
        </h2>
        <span className="text-[13px] text-fg-muted">
          {!auto.on ? '· nothing is read until you resume' : building ? `· your own Claude (${auto.model}) is reading your sessions` : '· a session is read 10 minutes after it goes quiet'}
        </span>
        <span className="ml-auto"><PauseButton auto={auto} onChanged={onChanged} /></span>
      </div>

      <Problem auto={auto} onChanged={onChanged} />

      <div className="grid gap-3 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
      <div className="relative min-h-[240px] overflow-hidden rounded-[12px] border border-border bg-panel" data-brain-live-orb>
        <BrainOrb kinds={kinds} count={count} agents={agents} activity={brainActivity(auto)} landed={landed} className="absolute inset-0" ariaLabel="Second Brain being built" />
      </div>
      <div className="grid content-start gap-3 sm:grid-cols-3">
        <Card label="Reading now" className="sm:col-span-3">
          {r ? (
            <div className="grid min-w-0 gap-0.5" data-brain-reading>
              <span className="truncate text-[15px] font-medium text-fg" title={r.title}>{r.title || 'A session'}</span>
              <span className="truncate text-[13px] text-fg-muted">
                {[r.agent ? agentName(r.agent) : '', r.project, r.last_event_at ? `ran ${fmtAgo(r.last_event_at, now)}` : ''].filter(Boolean).join(' · ')}
              </span>
              <span className="text-[12px] text-fg-muted">reading for {Math.max(0, Math.round((now - r.started_at) / 1000))}s</span>
            </div>
          ) : (
            <span className="text-[14px] leading-snug text-fg-muted" data-brain-reading-idle>
              {!auto.on ? 'Paused.' : !auto.claude_found ? 'Nothing — Claude Code is needed.' : auto.pending > 0
                ? (nextIn > 0 && nextIn < 600 ? `Next session in ${nextIn > 90 ? `${Math.round(nextIn / 60)} min` : `${nextIn}s`}` : 'Opening the next session…')
                : 'Nothing waiting. New sessions come in as they finish.'}
            </span>
          )}
        </Card>
        <Card label="Sessions">
          <span className="text-[15px] text-fg" data-brain-sessions>
            <span className="num text-[22px] font-semibold">{f?.read ?? 0}</span>
            <span className="text-fg-muted"> of </span>
            <span className="num">{f ? `${f.sessions}${f.truncated ? '+' : ''}` : 0}</span>
          </span>
          <Bar share={f?.share ?? 0} label="Sessions read" />
          <span className="text-[12px] text-fg-muted">{reach}</span>
        </Card>
        <Card label="Memories found">
          <Ticker value={f?.memories ?? 0} className="text-[22px] font-semibold text-fg" />
          <span className="text-[12px] text-fg-muted">so far — each lands in the graph</span>
        </Card>
        <Card label="Today">
          <span className="text-[15px] text-fg"><span className="num text-[22px] font-semibold">{tokensShort(auto.spent)}</span><span className="text-fg-muted"> of {tokensShort(auto.daily_tokens)}</span></span>
          <Bar share={spentShare} label="Tokens used today" />
          <span className="text-[12px] text-fg-muted">tokens, your daily limit</span>
        </Card>
      </div>
      </div>

      {(f?.sources.length ?? 0) > 0 && (
        <div className="grid gap-1.5" data-brain-sources>
          <h3 className="text-[12px] font-medium uppercase tracking-[0.06em] text-fg-muted">Where it comes from</h3>
          <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-3">
            {f!.sources.map((s) => (
              <li key={s.project || '-'} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1" data-brain-source={s.project}>
                <span className="truncate text-[13.5px] text-fg" title={s.project}>{s.project || 'No project'}</span>
                <span className="text-[12.5px] text-fg-muted">
                  {s.read} of {s.read + s.pending} read · <span className="text-fg">{s.memories}</span> {s.memories === 1 ? 'memory' : 'memories'}
                </span>
                <Bar share={s.read + s.pending ? s.read / (s.read + s.pending) : 1} label={`${s.project || 'No project'}: sessions read`} className="col-span-2 h-[3px]" />
              </li>
            ))}
          </ul>
        </div>
      )}

      {recent.length > 0 && (
        <div className="grid gap-1" data-brain-recent>
          <h3 className="text-[12px] font-medium uppercase tracking-[0.06em] text-fg-muted">Just read</h3>
          <ul className="grid gap-0.5 text-[13px]">
            {recent.map((run) => (
              <li key={run.id} className="flex min-w-0 items-baseline gap-2">
                <span className={`shrink-0 ${run.status === 'failed' ? 'text-warn' : 'text-accent'}`} aria-hidden>{run.status === 'failed' ? '!' : '✓'}</span>
                <span className="min-w-0 truncate text-fg">{run.title || run.project || run.session_id.slice(0, 8)}</span>
                <span className="shrink-0 text-fg-muted">
                  {run.project && run.title ? `${run.project} · ` : ''}
                  {run.status === 'ok' ? `${run.nodes} ${run.nodes === 1 ? 'memory' : 'memories'}` : run.status === 'failed' ? 'failed, will retry' : 'too short'}
                  {' · '}{fmtAgo(run.finished_at, now)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** On and up to date, or paused, with memories: one quiet line, and a way back in. */
export function BrainLiveLine({ auto, onChanged }: { auto: BrainAutoStatus; onChanged: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg-muted" data-brain-live-line>
      <span className={`h-[7px] w-[7px] rounded-full ${auto.on ? 'bg-accent' : 'bg-fg-faint'}`} aria-hidden />
      <span>
        {auto.on
          ? <>Up to date · new sessions are read as they finish · {tokensShort(auto.spent)} of {tokensShort(auto.daily_tokens)} tokens today</>
          : 'Paused · nothing new is read'}
      </span>
      {!auto.on && <PauseButton auto={auto} onChanged={onChanged} />}
    </div>
  )
}
