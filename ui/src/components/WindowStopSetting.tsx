/**
 * The plan-window stop's one control: off, or the share of Claude's plan
 * window at which Caprock pauses the sessions it started (Premium; owner
 * decision, 2026-10-08; internal/cap/window.go).
 *
 * Three things the panel has to say, because each is a promise or a limit:
 *
 *  - **Only sessions Caprock started, only Claude Code.** Rule 7, stated on
 *    the panel like the daily cap's.
 *  - **They carry on by themselves.** The pause ends when the window resets;
 *    resuming one by hand earlier is respected — it is not paused again in
 *    the same window.
 *  - **It acts only on fresh figures.** The figures come from Claude Code's
 *    status line and only while a session runs. When they are missing or old
 *    the panel says so in words, because a stop that silently cannot fire is
 *    worse than no stop.
 */
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { usePlan } from '@/components/PlanPicker'
import { Choice, Section } from '@/components/SettingsParts'
import { countdown, resetClock } from '@/lib/limitclock'
import { fmtAgo } from '@/lib/format'
import type { WindowStop } from '@/lib/api'

/** The shares offered. 90 is the default and the free alert's own line. */
const SHARES = [80, 90, 95]

export function WindowStopSetting({ now = Date.now() }: { now?: number }) {
  const [plan, savePlan] = usePlan()
  const ws = useApi(() => api.windowStop(), [], { live: false, intervalMs: 15000 })
  if (!plan) return null
  const pct = plan.window_stop_pct ?? 0
  // A share set over the API that the buttons do not offer still shows as
  // chosen, rather than as nothing selected.
  const shares = SHARES.includes(pct) || pct === 0 ? SHARES : [...SHARES, pct].sort((a, b) => a - b)
  return (
    <Section
      title="Pause at the plan limit"
      // "on" only when it can act: without a licence the share is kept but
      // nothing is paused, and the header must not say otherwise.
      aside={
        <span className={`text-[12px] ${pct && ws.data?.licensed !== false ? 'text-premium-strong' : 'text-fg-faint'}`}>
          {!pct ? 'off' : ws.data?.licensed === false ? 'not active' : `on · ${pct}%`}
        </span>
      }
    >
      <Choice
        label="Pause at"
        value={String(pct)}
        options={[{ value: '0', label: 'Off' }, ...shares.map((v) => ({ value: String(v), label: `${v}%` }))]}
        onChange={(v) => savePlan({ window_stop_pct: Number(v) })}
      />
      <p className="text-[12px] leading-relaxed text-fg-muted">
        {pct ? (
          <>
            When Claude's 5-hour or weekly window passes {pct}%, Caprock pauses the Claude Code sessions it started
            and resumes them after the window resets. Resume one yourself and it is left alone until the next
            window. Sessions you started yourself are never touched.
          </>
        ) : (
          <>Off. Nothing is paused, whatever the window. The alert at 90% on Now stays either way.</>
        )}
      </p>
      <Figures ws={ws.data} now={now} />
      {ws.data && ws.data.paused.length > 0 && (
        <ul className="grid gap-1 border-t border-border pt-2 text-[12px]">
          {ws.data.paused.map((p) => (
            <li key={p.session_id} className="flex flex-wrap gap-x-2 text-fg-muted">
              <span className="text-fg">{p.project || p.session_id.slice(0, 8)}</span>
              <span>paused · resumes after {resetClock(p.resume_at * 1000, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

const NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly' }

/** What the stop would act on right now, and why not when it would not. */
function Figures({ ws, now }: { ws?: WindowStop; now: number }) {
  if (!ws) return null
  const figures = Array.isArray(ws.windows) ? ws.windows : []
  if (figures.length === 0) {
    return (
      <p className="text-[12px] leading-relaxed text-fg-faint">
        No plan figures yet. They come from Claude Code's status line while a Pro or Max session runs — run{' '}
        <span className="mono text-fg-muted">caprock statusline install</span>. API billing has no windows.
      </p>
    )
  }
  const newest = Math.max(...figures.map((f) => f.observed_at))
  const fresh = figures.some((f) => f.fresh)
  const minutes = Math.round((ws.fresh_for_s || 600) / 60)
  return (
    <p className="text-[12px] leading-relaxed text-fg-faint" data-testid="window-figures">
      {figures.map((f) => `${NAMES[f.window] ?? f.window} ${Math.round(f.used_percentage)}%`).join(' · ')}
      {' — '}reported {fmtAgo(newest, now)}
      {fresh ? (
        (() => {
          const next = Math.min(...figures.filter((f) => f.fresh).map((f) => f.resets_at * 1000))
          return `; the next reset is in ${countdown(next - now)}.`
        })()
      ) : (
        <>
          . <span className="text-warn">Too old to act on:</span> Caprock pauses nothing on figures older than {minutes}{' '}
          minutes. They refresh while a Claude Code session runs.
        </>
      )}
    </p>
  )
}
