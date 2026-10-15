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
 * - **The header strip** (BrainStrip) — the state, N of M over a bar, the
 *   step a read is at with the session being read, what it gives, and
 *   every figure, each once. Beside it turns the living brain.
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
 * The living brain (components/BrainOrb), the one the sidebar card draws,
 * sits beside the strip: sparks fly from the agents into it while it
 * reads, and a point lights up as each memory lands. No card below repeats
 * a figure of the strip's (owner's coordinator, 2026-10-15).
 */
import { useState } from 'react'
import { api, errText, type BrainAutoStatus } from '@/lib/api'
import { brainActivity, buildFigures, isBuilding, tokensShort, useBrainLanded } from '@/lib/brain'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { useAgentsUsed } from '@/components/BrainAgents'
import { BrainOrb } from '@/components/BrainOrb'
import '@/components/BrainLive.css'
import { BrainStrip } from './BrainStrip'

const ONE_MILLION = 1_000_000

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

export function BrainLive({ auto, onChanged, kinds, count, owner = true }: { auto: BrainAutoStatus; onChanged: () => void; kinds: string[]; count: number; owner?: boolean }) {
  const now = useNow(1000)
  const agents = useAgentsUsed()
  const landed = useBrainLanded()
  const f = buildFigures(auto, now)
  const building = isBuilding(auto)
  const recent = auto.recent.slice(0, 3)
  return (
    <section className="grid gap-3" aria-label="Building Second Brain" data-brain-live={building ? 'building' : 'idle'}>
      {/* The strip carries every figure once; the living brain sits beside it. */}
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_240px]">
        <BrainStrip auto={auto} memories={count} onChanged={onChanged} owner={owner} />
        <div className="relative min-h-[200px] overflow-hidden rounded-[12px] border border-border bg-panel" data-brain-live-orb>
          <BrainOrb kinds={kinds} count={count} agents={agents} activity={brainActivity(auto)} landed={landed} className="absolute inset-0" ariaLabel="Second Brain being built" />
        </div>
      </div>

      <Problem auto={auto} onChanged={onChanged} />

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
