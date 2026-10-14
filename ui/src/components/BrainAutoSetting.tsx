/**
 * Second Brain, built automatically (Premium, ADR-063): the switch, its
 * limit, what it has done, and the backfill.
 *
 * Off until the user says yes. Rule 4 lets an outbound call exist only when
 * the user turned it on and the place it is switched on says what it sends,
 * so the switch carries that line: a finished session's prompts and answers
 * go to the user's own `claude`, which sends them to Anthropic under the
 * user's login — the place the session itself went — and nothing to Caprock.
 */
import { useState } from 'react'
import { api, type BrainAutoStatus, type BrainEstimate } from '@/lib/api'
import { useBrainStatus } from '@/lib/brain'
import { fmtAgo, fmtTokens } from '@/lib/format'
import { Choice, Details, Section, Toggle } from '@/components/SettingsParts'

/** The daily limits offered, in tokens; the default is the middle one. */
const LIMITS = [100_000, 300_000, 1_000_000]

/** 100k, 300k, 1M: the limits as people say them. */
export function limitLabel(v: number): string {
  return v >= 1_000_000 && v % 1_000_000 === 0 ? `${v / 1_000_000}M` : v % 1000 === 0 ? `${v / 1000}k` : fmtTokens(v)
}

/** The line that says what turning it on sends, and where. */
export const BRAIN_DISCLOSURE =
  'A finished session’s prompts and answers go to your own claude, which sends them to Anthropic under your login — where the session already went. Nothing is sent to Caprock.'

export function BrainAutoSetting() {
  const { status, reload } = useBrainStatus()
  const auto = status?.auto
  const [err, setErr] = useState('')
  if (!status || !auto) return null
  const save = (b: Parameters<typeof api.brainSettings>[0]) => {
    setErr('')
    api.brainSettings(b).then(reload, (e: Error) => setErr(e.message))
  }
  const limit = LIMITS.includes(auto.daily_tokens) ? auto.daily_tokens : LIMITS[1]
  return (
    <Section
      title="Second Brain"
      aside={
        <span className={`text-[12px] ${auto.enabled ? 'text-premium-strong' : 'text-fg-faint'}`}>
          {!auto.on ? 'off' : auto.enabled ? 'on' : 'not active'}
        </span>
      }
    >
      <Toggle
        checked={auto.on}
        onChange={(v) => save({ auto: v })}
        label="Build it from finished sessions"
        hint={<>When a session has been quiet for ten minutes, a small model ({auto.model}) reads what it decided and found and keeps it as memories.</>}
      />
      {/* What it sends and where, on screen whatever the explanations
        * setting says (rule 4): it is the condition of the switch, not help. */}
      <p className="text-[12.5px] leading-relaxed text-fg-muted" data-brain-disclosure data-keep>{BRAIN_DISCLOSURE}</p>
      {auto.on && !auto.claude_found && (
        <p className="text-[12.5px] text-warn">
          Claude Code was not found, so nothing is read. Install it, or put <span className="mono">claude</span> on the PATH Caprock started with.
        </p>
      )}
      <Choice
        label="Daily limit"
        value={String(limit)}
        options={LIMITS.map((v) => ({ value: String(v), label: limitLabel(v) }))}
        onChange={(v) => save({ daily_tokens: Number(v) })}
      />
      <Figures auto={auto} />
      {err && <p className="text-[12.5px] text-danger">{err}</p>}
      <Backfill on={auto.on} />
      {auto.recent.length > 0 && <Recent auto={auto} />}
    </Section>
  )
}

function Figures({ auto }: { auto: BrainAutoStatus }) {
  return (
    <div className="grid gap-0.5 text-[12.5px] text-fg-muted" data-brain-figures>
      <span>
        Used in the last 24 hours: <span className="mono text-fg">{fmtTokens(auto.spent)}</span> of{' '}
        <span className="mono">{limitLabel(auto.daily_tokens)}</span> tokens
        {auto.spent >= auto.daily_tokens ? ' — reading resumes as the day rolls over' : ''}.
      </span>
      {auto.on && (
        <span>
          {auto.running ? 'Reading now. ' : ''}
          {auto.pending > 0 ? `${auto.pending} session${auto.pending === 1 ? '' : 's'} waiting to be read.` : 'Nothing waiting.'}
          {auto.last_wake ? ` Last looked ${fmtAgo(auto.last_wake)}.` : ''}
        </span>
      )}
      {auto.last_error && <span className="text-warn">Last problem: {auto.last_error}</span>}
    </div>
  )
}

/** "Build from my last 30 days": an estimate first, then a yes. */
function Backfill({ on }: { on: boolean }) {
  const [est, setEst] = useState<BrainEstimate | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState('')
  const ask = () => {
    setErr('')
    setBusy(true)
    api.brainBackfill(30).then(setEst, (e: Error) => setErr(e.message)).finally(() => setBusy(false))
  }
  const start = () => {
    setBusy(true)
    api.brainBackfill(30, true).then(() => { setDone(true); setEst(null) }, (e: Error) => setErr(e.message)).finally(() => setBusy(false))
  }
  return (
    <div className="grid gap-2 border-t border-border pt-3" data-brain-backfill>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="rounded-[6px] border border-border px-3 py-1.5 text-[13px] text-fg hover:text-accent disabled:opacity-50 disabled:hover:text-fg" disabled={!on || busy} onClick={ask}>Build from my last 30 days</button>
        {!on && <span className="text-[12px] text-fg-faint">Turn it on first.</span>}
        {done && <span className="text-[12px] text-fg-muted">Started: the past month is read a few sessions at a time, within the daily limit.</span>}
      </div>
      {est && (
        <div className="grid gap-2 rounded-md bg-panel-2 p-3 text-[12.5px]">
          {est.sessions === 0 ? (
            <span className="text-fg-muted">Nothing to read: every session of the past month is read already, or too short to keep anything from.</span>
          ) : (
            <>
              <span className="text-fg">
                {est.sessions}{est.truncated ? '+' : ''} session{est.sessions === 1 ? '' : 's'} to read, about{' '}
                <span className="mono">{fmtTokens(est.tokens_estimate)}</span> tokens
                {est.days_estimate > 1 ? `, over about ${est.days_estimate} days at your daily limit` : ''}.
              </span>
              <span className="text-fg-muted">An estimate from the transcripts&rsquo; length, before anything is sent.</span>
              <span className="flex gap-2">
                <button type="button" className="rounded-[6px] bg-accent px-3 py-1.5 text-[13px] font-medium text-panel disabled:opacity-50" disabled={busy} onClick={start}>Start</button>
                <button type="button" className="rounded-[6px] border border-border px-3 py-1.5 text-[13px] text-fg hover:text-accent disabled:opacity-50 disabled:hover:text-fg" onClick={() => setEst(null)}>Cancel</button>
              </span>
            </>
          )}
        </div>
      )}
      {err && <span className="text-[12.5px] text-danger">{err}</span>}
    </div>
  )
}

function Recent({ auto }: { auto: BrainAutoStatus }) {
  return (
    <Details summary="Recent reads">
      <ul className="grid gap-1 text-[12px]">
        {auto.recent.map((r) => (
          <li key={r.id} className="flex flex-wrap gap-x-2 text-fg-muted">
            <span className="text-fg">{r.project || r.session_id.slice(0, 8)}</span>
            <span>{fmtAgo(r.finished_at)}</span>
            <span>
              {r.status === 'ok' ? `${r.nodes} kept · ${fmtTokens(r.tokens_in + r.tokens_out)} tokens`
                : r.status === 'skipped' ? 'skipped: too short'
                : `failed: ${r.error ?? ''}`}
            </span>
          </li>
        ))}
      </ul>
    </Details>
  )
}

/**
 * The question, asked once on the Brain screen with a licence: build it
 * automatically, or not. Either answer is kept; Settings changes it later.
 */
export function BrainConsent({ auto, onAnswer }: { auto: BrainAutoStatus; onAnswer: () => void }) {
  const [busy, setBusy] = useState(false)
  if (auto.chosen) return null
  const answer = (v: boolean) => {
    setBusy(true)
    api.brainSettings({ auto: v }).then(onAnswer, () => setBusy(false))
  }
  return (
    <div className="grid max-w-[760px] gap-2 rounded-[var(--radius-panel)] border border-border bg-panel p-4" data-brain-consent>
      <span className="text-[14.5px] font-medium text-fg">Build it from your sessions automatically?</span>
      <span className="text-[12.5px] leading-relaxed text-fg-muted">
        When a session has been quiet for ten minutes, a small model reads what it decided and found and keeps it here,
        within a daily limit of {limitLabel(auto.daily_tokens)} tokens. {BRAIN_DISCLOSURE}
      </span>
      <span className="flex gap-2">
        <button type="button" className="rounded-[6px] bg-accent px-3 py-1.5 text-[13px] font-medium text-panel disabled:opacity-50" disabled={busy} onClick={() => answer(true)}>Turn it on</button>
        <button type="button" className="rounded-[6px] border border-border px-3 py-1.5 text-[13px] text-fg hover:text-accent disabled:opacity-50 disabled:hover:text-fg" disabled={busy} onClick={() => answer(false)}>Not now</button>
      </span>
    </div>
  )
}
