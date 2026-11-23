/**
 * Second Brain, built automatically (ADR-063): the switch, the agent it
 * reads with (ADR-103), its limit, what it has done, and the backfill. Free
 * for everyone (owner decision, 2026-10-14): it runs on the user's own
 * coding agent — Claude Code, Codex, Cursor or Gemini CLI.
 *
 * Off until the user says yes. Rule 4 lets an outbound call exist only when
 * the user turned it on and the place it is switched on says what it sends,
 * so the switch carries that line, for the agent that reads: a finished
 * session's prompts and answers go to the user's own agent, which sends
 * them to its vendor under the user's login, and nothing to Caprock.
 */
import { useState } from 'react'
import { api, type BrainAutoStatus, type BrainEstimate, type BrainSettings } from '@/lib/api'
import { brainArrivalsSetting, brainDisclosure, brainFailureReason, brainRunOutcome, READER_LABELS, readerName, readerProblem, setBrainArrivals, useBrainStatus } from '@/lib/brain'
import { fmtAgo, fmtTokens } from '@/lib/format'
import { Choice, Details, Section, Toggle } from '@/components/SettingsParts'

/** The daily limits offered, in tokens; the default is the middle one. */
const LIMITS = [100_000, 300_000, 1_000_000]

/** 100k, 300k, 1M: the limits as people say them. */
export function limitLabel(v: number): string {
  return v >= 1_000_000 && v % 1_000_000 === 0 ? `${v / 1_000_000}M` : v % 1000 === 0 ? `${v / 1000}k` : fmtTokens(v)
}

/** The line that says what turning it on sends, and where, when Claude Code reads. */
export const BRAIN_DISCLOSURE = brainDisclosure('claude')

export function BrainAutoSetting() {
  const { status, reload } = useBrainStatus()
  const auto = status?.auto
  const [err, setErr] = useState('')
  if (!status || !auto) return null
  const save = (b: BrainSettings) => {
    setErr('')
    return api.brainSettings(b).then(reload, (e: Error) => setErr(e.message))
  }
  const limit = LIMITS.includes(auto.daily_tokens) ? auto.daily_tokens : LIMITS[1]
  return (
    <Section
      title="2nd Brain"
      aside={
        <span className={`text-[12px] ${auto.enabled ? 'text-accent' : 'text-fg-faint'}`}>
          {!auto.on ? 'off' : auto.enabled ? 'on' : 'not active'}
        </span>
      }
    >
      <Toggle
        checked={auto.on}
        onChange={(v) => save({ auto: v })}
        label="Build it from finished sessions"
        hint={<>When a session has been quiet for ten minutes, {readerName(auto) || 'your coding agent'} ({auto.model || 'its default model'}) reads what it decided and found and keeps it as memories.</>}
      />
      {/* What it sends and where, on screen whatever the explanations
        * setting says (rule 4): it is the condition of the switch, not help. */}
      <p className="text-[12.5px] leading-relaxed text-fg-muted" data-brain-disclosure data-keep>{brainDisclosure(auto.reader || 'claude')}</p>
      {auto.on && readerProblem(auto) && (
        <p className="text-[12.5px] text-warn" data-brain-reader-problem>{readerProblem(auto)}</p>
      )}
      {auto.readers && <ReadWith auto={auto} save={save} />}
      <Choice
        label="Daily limit"
        value={String(limit)}
        options={LIMITS.map((v) => ({ value: String(v), label: limitLabel(v) }))}
        onChange={(v) => save({ daily_tokens: Number(v) })}
      />
      <ExcludeFolders folders={auto.exclude ?? []} save={save} />
      <ArrivalsToggle />
      <Figures auto={auto} />
      {err &&<p className="text-[12.5px] text-danger">{err}</p>}
      <Backfill on={auto.on} />
      {auto.recent.length > 0 && <Recent auto={auto} />}
    </Section>
  )
}

/**
 * *Never read these folders*: the folders whose sessions Second Brain skips
 * (`brain.exclude`). A scheduled job's runs — the owner's scout every 15
 * minutes — filled the brain with run chatter (2026-10-24); a job that says
 * `automation: true` when it starts needs no entry here, this is for the
 * rest. Their projects are left out of the graph, search and the handoff
 * unless opened by name; nothing is deleted. A session started at the disk
 * root or in the home folder itself — launchd and cron start a job in "/" —
 * is never read at all (store.RootOrHome), and the line says so: the list
 * refuses those two folders.
 */
function ExcludeFolders({ folders, save }: { folders: string[]; save: (b: BrainSettings) => Promise<void> }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const put = (next: string[]) => {
    setBusy(true)
    save({ exclude: next }).finally(() => setBusy(false))
  }
  const add = () => {
    const p = draft.trim()
    if (!p) return
    put([...folders, p])
    setDraft('')
  }
  return (
    <div className="grid min-w-0 gap-1.5" data-brain-exclude>
      <span className="text-[13px] text-fg">Never read these folders</span>
      <span className="text-[12.5px] leading-relaxed text-fg-muted">
        Sessions in them, or in a repository under them, are skipped unread, and their projects stay out of the graph, search and what a new session is handed unless you open that project. A scheduled job that says so when it starts is skipped on its own. Sessions started at the disk root or in your home folder itself, where scheduled jobs run, are never read. Nothing already kept is deleted.
      </span>
      {folders.length > 0 && (
        <ul className="grid gap-1 text-[12.5px]">
          {folders.map((f) => (
            <li key={f} className="flex items-center gap-2">
              <span className="mono min-w-0 flex-1 truncate text-fg" title={f}>{f}</span>
              <button type="button" className="text-fg-faint hover:text-danger disabled:opacity-50" aria-label={`Stop excluding ${f}`} disabled={busy} onClick={() => put(folders.filter((x) => x !== f))}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex min-w-0 gap-2">
        <input
          type="text"
          size={1}
          value={draft}
          placeholder="/Users/you/dev/scheduled-jobs"
          aria-label="Folder to exclude"
          className="mono min-w-0 flex-1 rounded-[6px] border border-border bg-panel px-2 py-1 text-[12.5px] text-fg placeholder:text-fg-faint"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
        />
        <button type="button" className="shrink-0 rounded-[6px] border border-border px-3 py-1 text-[13px] text-fg hover:text-accent disabled:opacity-50 disabled:hover:text-fg" disabled={busy || !draft.trim()} onClick={add}>Exclude</button>
      </div>
    </div>
  )
}

/** *Show memories moving* (it was *Animate thoughts arriving*; same key): kept in this browser, on unless turned off (04-ui.md § Second Brain). */
function ArrivalsToggle() {
  const [on, setOn] = useState(brainArrivalsSetting)
  return (
    <Toggle
      checked={on}
      onChange={(v) => { setOn(v); setBrainArrivals(v) }}
      label="Show memories moving"
      hint="A session’s new memories drift into 2nd Brain as a silver thread, and the ones a new session is handed drift into its tab. At most one a minute each way, never while you type. With reduced motion only the count shows."
    />
  )
}

/**
 * *Read with*: the agent the reads go through (ADR-103) — Auto, the
 * installed agent the user works in most, or one chosen; only installed
 * agents are offered. Beside it, the model for an agent other than Claude
 * Code (whose stays haiku or sonnet), empty for that CLI's own default.
 */
function ReadWith({ auto, save }: { auto: BrainAutoStatus; save: (b: BrainSettings) => Promise<void> }) {
  const readers = auto.readers ?? []
  const installed = readers.filter((r) => r.installed)
  const setting = auto.reader_setting ?? 'auto'
  const current = readers.find((r) => r.id === auto.reader)
  const options = [
    { value: 'auto', label: setting === 'auto' && current ? `Auto (${current.label})` : 'Auto' },
    ...installed.map((r) => ({ value: r.id, label: r.label })),
  ]
  const missing = readers.filter((r) => !r.installed).map((r) => r.label)
  return (
    <div className="grid gap-1.5" data-brain-read-with>
      <Choice
        label="Read with"
        value={setting}
        options={options}
        onChange={(v) => save({ reader: v as BrainSettings['reader'] })}
      />
      <span className="text-[12.5px] leading-relaxed text-fg-muted">
        Auto reads with the agent you used most in the last 30 days, Claude Code on a tie.
        {missing.length > 0 ? ` Not installed here: ${missing.join(', ')}.` : ''}
        {current && !current.reports_tokens ? ` ${current.label} reports no token usage, so its reads are counted instead: up to ${auto.daily_reads ?? 0} a day.` : ''}
        {current && current.reports_tokens && !current.reports_cost ? ` ${current.label} reports tokens but no cost, so cost shows only for Claude Code’s reads.` : ''}
      </span>
      {current && current.id !== 'claude' && <ReaderModel key={current.id} id={current.id} model={current.model} save={save} />}
    </div>
  )
}

function ReaderModel({ id, model, save }: { id: Exclude<NonNullable<BrainAutoStatus['reader']>, '' | 'claude'>; model: string; save: (b: BrainSettings) => Promise<void> }) {
  const [draft, setDraft] = useState(model)
  const put = () => {
    const v = draft.trim()
    if (v !== model) void save({ models: { [id]: v } })
  }
  return (
    <label className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
      <span className="w-40 shrink-0 text-fg">Model for {READER_LABELS[id]}</span>
      <input
        type="text"
        size={1}
        value={draft}
        placeholder="its own default"
        aria-label={`Model for ${READER_LABELS[id]}`}
        className="mono min-w-0 flex-1 rounded-[6px] border border-border bg-panel px-2 py-1 text-[12.5px] text-fg placeholder:text-fg-faint"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={put}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); put() } }}
      />
    </label>
  )
}

function Figures({ auto }: { auto: BrainAutoStatus }) {
  return (
    <div className="grid gap-0.5 text-[12.5px] text-fg-muted" data-brain-figures>
      {(auto.no_usage_reads ?? 0) > 0 && (
        <span data-brain-reads>
          Reads with no reported tokens in the last 24 hours: <span className="mono text-fg">{auto.no_usage_reads}</span> of{' '}
          <span className="mono">{auto.daily_reads}</span>
          {(auto.no_usage_reads ?? 0) >= (auto.daily_reads ?? 0) ? ' — reading resumes as the day rolls over' : ''}.
        </span>
      )}
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
      {(auto.automation_24h ?? 0) > 0 && (
        <span data-brain-automation>
          {auto.automation_24h} automation session{auto.automation_24h === 1 ? '' : 's'} skipped unread in the last 24 hours.
        </span>
      )}
      {auto.last_error && <span className="text-warn" title={`The error: ${auto.last_error}`} data-brain-last-problem>Last problem: {brainFailureReason(auto.last_error)}.</span>}
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
              {r.reader && r.reader !== 'claude' ? `${READER_LABELS[r.reader] ?? r.reader} · ` : ''}
              {r.status === 'ok' ? `${r.nodes} kept · ${r.no_usage ? 'tokens not reported' : `${fmtTokens(r.tokens_in + r.tokens_out)} tokens`}`
                : r.status === 'skipped' ? `skipped: ${brainRunOutcome(r)}`
                : `failed: ${r.error ?? ''}`}
            </span>
          </li>
        ))}
      </ul>
    </Details>
  )
}
