/**
 * The agent cockpit (.ai/21-app.md § Agent cockpit): the inspector as it reads
 * beside an agent's terminal. What only Caprock knows about the session in
 * front — what it has cost and what each call costs now, how full its context
 * is, what it is doing this second, what it did a moment ago and how long each
 * step took, how much of the plan is left, and whether it is going round in
 * circles.
 *
 * Every figure is the daemon's: the session row the sidebar already polls,
 * the session's own events (fetched once, then followed on the live socket),
 * and the day's summary for the plan windows. Nothing here is estimated, and a
 * figure an agent does not report is left out rather than drawn as a zero.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, type Event, type Permission, type RateWindow, type SessionSummary, type SubagentsNow, type Summary } from '@/lib/api'
import { usePermission } from './PermissionPrompt'
import { live } from '@/lib/live'
import { mergeEvents } from '@/lib/chat'
import { fmtAgo, fmtPct, fmtTokens, fmtUSD } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { countdown, resetClock } from '@/lib/limitclock'
import { readWindow } from './PlanLimits'
import { AgentCharacter, agentName, characterFor } from './Characters'
import {
  askLine, backgroundAgents, backgroundLabel, cockpitState, commandGist, fmtRun, mainThread, planWindowsFor, requester, runningTool, runShare, runVerb, subagentWaiting, toolKind, toolRuns, turnCosts,
  type CockpitState, type ToolKind, type ToolRun, type TurnCost,
} from '@/lib/cockpit'

/** How many of the main thread's newest calls and turns the panel reads: enough for the last several turns. */
const EVENTS_HELD = 400
const TIMELINE_ROWS = 7
const SPARK_TURNS = 28
const SUBAGENT_ROWS = 5
/** The subagent list is read again at most this often while their events stream in. */
const SUBAGENTS_THROTTLE_MS = 2_000
/** …and this often regardless, so a finished or silent one drops off. */
const SUBAGENTS_POLL_MS = 20_000
/** The kinds the tool list and the cost spark are made of. */
const MAIN_KINDS = ['tool.pre', 'tool.post', 'turn.assistant'] as const

function isMainKind(e: Event): boolean {
  return (MAIN_KINDS as readonly string[]).includes(e.kind) && mainThread(e)
}

/**
 * The main thread's own calls and turns, kept current from the live socket.
 * Fetched filtered (`main=1&kind=…`): a parent whose subagents log hundreds of
 * events an hour had none of its own among its newest 400.
 */
export function useSessionEvents(sessionId: string): readonly Event[] {
  const [main, setMain] = useState<readonly Event[]>([])
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    api.recentMainEvents(sessionId, MAIN_KINDS, EVENTS_HELD)
      .then((list) => { if (alive && Array.isArray(list)) setMain((cur) => mergeEvents(cur, list.filter(isMainKind)).slice(-EVENTS_HELD)) })
      .catch(() => { /* an older daemon or a gone session: the panel shows what the row has */ })
    return () => { alive = false }
  }, [sessionId, nonce])
  useEffect(() => live.onFrame((f) => {
    if (f.type === 'event' && f.data.session_id === sessionId) {
      const e = f.data
      if (isMainKind(e)) setMain((cur) => { const next = mergeEvents(cur, [e]); return next === cur ? cur : next.slice(-EVENTS_HELD) })
    } else if (f.type === 'reset' || (f.type === 'hello' && f.data.reset)) {
      setNonce((n) => n + 1)
    }
  }), [sessionId])
  return main
}

/**
 * The subagents working in the session, as the daemon sums them up
 * (`/subagents`): read on open, again at most every two seconds while their
 * events stream in on the live socket, and every twenty seconds so one that
 * finished drops off. The daemon does the counting; thousands of subagent
 * events never reach the page.
 */
export function useSubagents(sessionId: string, enabled: boolean): SubagentsNow | undefined {
  const [data, setData] = useState<SubagentsNow | undefined>(undefined)
  const [tick, setTick] = useState(0)
  const last = useRef(0)
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    last.current = Date.now()
    api.subagents(sessionId)
      .then((r) => { if (alive && r && Array.isArray(r.working)) setData(r) })
      .catch(() => { /* an older daemon: no section */ })
    return () => { alive = false }
  }, [sessionId, enabled, tick])
  useEffect(() => {
    if (!enabled) return
    const poll = setInterval(() => setTick((t) => t + 1), SUBAGENTS_POLL_MS)
    const off = live.onFrame((f) => {
      if (f.type !== 'event' || f.data.session_id !== sessionId || !f.data.agent_id || pending.current) return
      const wait = Math.max(0, last.current + SUBAGENTS_THROTTLE_MS - Date.now())
      pending.current = setTimeout(() => { pending.current = undefined; setTick((t) => t + 1) }, wait)
    })
    return () => {
      clearInterval(poll)
      off()
      if (pending.current) { clearTimeout(pending.current); pending.current = undefined }
    }
  }, [sessionId, enabled])
  return enabled ? data : undefined
}

const STATE_LABEL: Record<CockpitState, string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  looping: 'Looping?',
  idle: 'Idle',
  ended: 'Ended',
}

const STATE_TEXT: Record<CockpitState, string> = {
  working: 'text-ok',
  waiting: 'text-accent',
  looping: 'text-danger',
  idle: 'text-fg-muted',
  ended: 'text-fg-faint',
}

/** The cockpit's sections below the permission card, in reading order. */
export function Cockpit({ s, sessionId, hasPermission, summary, changes }: {
  s: SessionSummary
  sessionId: string
  hasPermission: boolean
  summary?: Summary
  /** The working tree's changes, drawn by the inspector (it owns the diff fetch). */
  changes?: ReactNode
}) {
  const main = useSessionEvents(sessionId)
  const [permission] = usePermission(sessionId)
  const now = useNow(1000)
  const runs = useMemo(() => toolRuns(main), [main])
  const turns = useMemo(() => turnCosts(main), [main])
  const state = cockpitState(s, hasPermission || !!permission)
  // Claude Code is the agent with subagents Caprock hears from.
  const subs = useSubagents(sessionId, state !== 'ended' && (s.agent ?? 'claude') === 'claude')
  const running = state === 'working' || state === 'looping' ? runningTool(runs, now) : undefined
  const plan = planWindowsFor(s.agent, summary)
  return (
    <>
      <Hero s={s} state={state} now={now} background={hasPermission || permission ? 0 : backgroundAgents(s)} />
      <Spend s={s} turns={turns} />
      <ContextMeter s={s} />
      <NowDoing s={s} state={state} running={running} last={runs[runs.length - 1]} permission={permission} background={backgroundAgents(s)} now={now} />
      {subs && subs.working.length > 0 && <Subagents subs={subs} permission={permission} now={now} />}
      {s.loop && state !== 'ended' && <LoopWarning s={s} now={now} />}
      <Timeline runs={runs} total={s.stats?.tool_calls} now={now} />
      {changes}
      {plan && <PlanWindows limits={plan} agent={s.agent} now={now} />}
    </>
  )
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <h4 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">{children}</h4>
      {right && <div className="ml-auto flex items-baseline gap-2 text-[11.5px]">{right}</div>}
    </div>
  )
}

function Hero({ s, state, now, background }: { s: SessionSummary; state: CockpitState; now: number; background: number }) {
  const since = s.worked_at || s.last_event_at
  return (
    <div className="flex items-center gap-3.5" data-state={state}>
      <div className={`cockpit-avatar relative grid h-[58px] w-[58px] shrink-0 place-items-center rounded-[15px]`} data-state={state}>
        <AgentCharacter who={characterFor(s.agent ?? 'claude')} size={46} className="cockpit-character" />
      </div>
      <div className="grid min-w-0 gap-1">
        <p className="text-[12px] text-fg-muted">
          <span className="font-medium text-fg">{agentName(s.agent ?? 'claude')}</span>
          {s.model_display || s.model ? <span> · {s.model_display || s.model}</span> : null}
        </p>
        <p className={`flex items-center gap-1.5 text-[12px] font-medium ${STATE_TEXT[state]}`} role="status">
          <span className={`cockpit-dot inline-block h-[7px] w-[7px] rounded-full`} data-state={state} />
          {background > 0 && state === 'working' ? backgroundLabel(background) : STATE_LABEL[state]}
          {(state === 'idle' || state === 'ended') && since ? <span className="font-normal text-fg-faint">· {fmtAgo(since, now)}</span> : null}
        </p>
        {s.started_at > 0 && state !== 'ended' && (
          <p className="text-[11px] text-fg-faint">started {fmtAgo(s.started_at, now)}</p>
        )}
        {(s.live_subagents ?? 0) > 0 && !(background > 0 && state === 'working') && (
          <p className="text-[11.5px] text-fg-muted">{s.live_subagents} {s.live_subagents === 1 ? 'subagent' : 'subagents'} working</p>
        )}
      </div>
    </div>
  )
}


/** A number that counts up to its new value rather than jumping. */
function useTweened(value: number, ms = 650): number {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    const start = from.current
    if (start === value || typeof requestAnimationFrame !== 'function') { from.current = value; setShown(value); return }
    let raf = 0
    const t0 = performance.now()
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms)
      const eased = 1 - Math.pow(1 - k, 3)
      const v = start + (value - start) * eased
      from.current = v
      setShown(v)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, ms])
  return shown
}

function Spend({ s, turns }: { s: SessionSummary; turns: TurnCost[] }) {
  const st = s.stats
  const cost = st?.cost_usd ?? 0
  const shown = useTweened(cost)
  const last = turns[turns.length - 1]
  const tokensIn = st ? st.tokens_in + st.cache_read + st.cache_write : undefined
  return (
    <section aria-label="Spend" className="grid gap-2.5">
      <SectionLabel right={last ? <span className="num text-fg-faint" title="What the newest model call cost">last call <span className="text-fg">{fmtUSD(last.cost)}</span></span> : undefined}>
        Spent this session
      </SectionLabel>
      <div className="flex items-end justify-between gap-3">
        <span className="num text-[34px] font-semibold leading-none tracking-[-0.03em] text-fg" aria-label={`Cost ${fmtUSD(cost)}`}>{fmtUSD(shown)}</span>
        <TurnSpark turns={turns.slice(-SPARK_TURNS)} />
      </div>
      {st && (
        <dl className="grid grid-cols-4 overflow-hidden rounded-[9px] border border-[var(--app-hairline)]">
          <Cell label="Turns" value={String(st.turns)} />
          <Cell label="Tools" value={String(st.tool_calls)} />
          <Cell label="Tokens" value={fmtTokens(tokensIn)} title={`${fmtTokens(tokensIn)} in · ${fmtTokens(st.tokens_out)} out`} />
          <Cell label="Cache" value={tokensIn ? fmtPct((s.savings?.hit_rate ?? 0) * 100) : '—'} title="Share of input tokens read from the prompt cache" />
        </dl>
      )}
    </section>
  )
}

function Cell({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="grid gap-0.5 border-l border-[var(--app-hairline)] px-2 py-1.5 first:border-l-0" title={title}>
      <dt className="text-[10px] uppercase tracking-[0.06em] text-fg-faint">{label}</dt>
      <dd className="num truncate text-[13px] font-medium text-fg">{value}</dd>
    </div>
  )
}

/** What each of the last turns cost, newest at the right. */
function TurnSpark({ turns }: { turns: TurnCost[] }) {
  if (turns.length < 2) return null
  const max = Math.max(...turns.map((t) => t.cost), 0.0001)
  const W = 112, H = 30, gap = 1.5
  const bw = Math.max(1.5, (W - gap * (SPARK_TURNS - 1)) / SPARK_TURNS)
  const x0 = W - turns.length * (bw + gap) + gap
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Cost of the last ${turns.length} model calls`} className="mb-[3px] shrink-0 overflow-visible">
      {turns.map((t, i) => {
        const h = Math.max(1.5, (t.cost / max) * H)
        const newest = i === turns.length - 1
        return (
          <rect key={t.id} x={x0 + i * (bw + gap)} y={H - h} width={bw} height={h} rx={Math.min(1, bw / 2)}
            className={newest ? 'cockpit-spark-new fill-accent' : 'fill-accent'} opacity={newest ? 1 : 0.28 + 0.5 * (i / turns.length)}>
            <title>{fmtUSD(t.cost)}</title>
          </rect>
        )
      })}
    </svg>
  )
}

function ContextMeter({ s }: { s: SessionSummary }) {
  const ctx = s.context
  if (!ctx) {
    return (
      <section aria-label="Context" className="grid gap-2">
        <SectionLabel right={<span className="text-fg-faint">{s.context_note ?? 'not measured yet'}</span>}>Context</SectionLabel>
      </section>
    )
  }
  const pct = Math.max(0, Math.min(100, ctx.pct))
  const tone = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'ok'
  return (
    <section aria-label="Context" className="grid gap-2">
      <SectionLabel right={<span className="num text-fg-muted"><span className="text-fg">{fmtTokens(ctx.tokens)}</span> / {fmtTokens(ctx.window)}</span>}>Context</SectionLabel>
      <div className="cockpit-track relative h-[9px] overflow-hidden rounded-full" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className="cockpit-fill h-full rounded-full" data-tone={tone} style={{ width: `${Math.max(pct, 1.5)}%` }} />
        {[25, 50, 75].map((m) => <span key={m} aria-hidden className="absolute top-0 h-full w-px bg-[var(--app-chrome-bg)] opacity-70" style={{ left: `${m}%` }} />)}
      </div>
      <p className="text-[11.5px] text-fg-muted">
        <span className={`num font-medium ${tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-fg'}`}>{fmtPct(pct)}</span> full
        {ctx.next_call_usd > 0 && <> · every call now re-reads it for <span className="num text-fg">{fmtUSD(ctx.next_call_usd)}</span></>}
      </p>
    </section>
  )
}

function NowDoing({ s, state, running, last, permission, background, now }: {
  s: SessionSummary
  state: CockpitState
  running?: ToolRun
  last?: ToolRun
  permission?: Permission | null
  /** Subagents working after the turn ended (backgroundAgents). */
  background: number
  now: number
}) {
  let icon: ReactNode
  let verb: string
  let detail = ''
  let full = ''
  let right: ReactNode = null
  const waiting = permission?.waiting && permission.waiting.length > 1 ? permission.waiting : undefined
  if (permission && state !== 'ended') {
    // The prompt's own words, naming who asks: a subagent's dialog is drawn
    // in the parent's terminal, and the narrated phrase named neither.
    icon = <KindIcon kind="ask" />
    if (waiting) {
      verb = `${waiting.length} approvals waiting`
      detail = waiting.map((w) => `${requester(w, agentName(s.agent ?? 'claude'))}: ${w.tool}`).join(' · ')
      full = waiting.map((w) => `${askLine(w, agentName(s.agent ?? 'claude'))}\n${w.detail}`).join('\n\n')
    } else {
      verb = askLine(permission, agentName(s.agent ?? 'claude'))
      detail = commandGist(permission.detail).gist
      full = permission.detail
    }
    right = <span className="num text-[11.5px] text-fg-muted">{fmtAgo(permission.since, now)}</span>
  } else if (background > 0 && state === 'working') {
    // The turn ended with subagents still at work. Nothing is wanted from
    // the user: Claude Code picks the session up when they finish. Before
    // the main thread's last call, which "Thinking after …" would name.
    icon = <KindIcon kind="agent" />
    verb = backgroundLabel(background)
    detail = 'resumes when they finish'
  } else if (running) {
    icon = <KindIcon kind={running.kind} />
    verb = running.kind === 'mcp' || running.kind === 'other' ? `${runVerb(running.kind)} ${running.tool.replace(/^mcp__(.+?)__/, '$1·')}` : runVerb(running.kind)
    detail = running.detail
    right = <span className="num text-[11.5px] text-fg-muted">{fmtRun(Math.max(0, now - running.startMs))}</span>
  } else if (state === 'working' && last?.endMs !== undefined) {
    // Between calls: the model is writing its next step. The narrated phrase
    // still names the call that just finished, which read as still running.
    icon = <KindIcon kind="think" />
    verb = 'Thinking'
    detail = `after ${last.tool}${last.detail ? ` ${last.detail}` : ''}`
    right = <span className="num text-[11.5px] text-fg-muted">{fmtRun(Math.max(0, now - last.endMs))}</span>
  } else if (state === 'working') {
    icon = <KindIcon kind="think" />
    verb = capital(s.activity?.phrase || 'working')
  } else if (state === 'waiting') {
    icon = <KindIcon kind="ask" />
    verb = capital(s.activity?.phrase || 'waiting for you')
  } else if (state === 'looping') {
    icon = <KindIcon kind="loop" />
    verb = capital(s.activity?.phrase || 'repeating itself')
  } else if (state === 'ended') {
    icon = <KindIcon kind="stop" />
    verb = 'Process ended'
  } else {
    icon = <KindIcon kind="pause" />
    verb = s.activity?.phrase ? capital(s.activity.phrase) : 'Nothing running'
  }
  const plan = s.activity?.plan
  return (
    <section aria-label="Now" className="grid gap-2">
      <SectionLabel right={plan && plan.total > 0 ? <span className="num text-fg-muted" title={plan.next ? `Next: ${plan.next}` : undefined}>plan {plan.done}/{plan.total}</span> : undefined}>Now</SectionLabel>
      <div className="cockpit-now flex items-center gap-2.5 rounded-[10px] border px-2.5 py-2" data-state={state} data-running={running ? 'true' : undefined}>
        <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] bg-[var(--app-row-active)]">{icon}</span>
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className={`${permission ? 'line-clamp-2' : 'truncate'} text-[12.5px] font-medium text-fg`}>{verb}</span>
          {detail && (
            <span className={`mono text-[11.5px] text-fg-muted ${permission ? 'line-clamp-2 break-all' : 'truncate'}`} title={full || detail}>{detail}</span>
          )}
        </span>
        {right}
      </div>
    </section>
  )
}

/**
 * The subagents at work, one compact row each: its type and what the parent
 * asked of it, its current call and how long it has run, how many calls it
 * has made, and a badge while it waits on a permission prompt. Those that
 * finished lately are one line under them.
 */
function Subagents({ subs, permission, now }: { subs: SubagentsNow; permission?: Permission | null; now: number }) {
  const shown = subs.working.slice(0, SUBAGENT_ROWS)
  const hidden = subs.working.length - shown.length
  return (
    <section aria-label="Subagents" className="grid gap-2">
      <SectionLabel right={subs.finished > 0 ? <span className="text-fg-faint">{subs.finished} finished</span> : undefined}>
        Subagents · {subs.working.length}
      </SectionLabel>
      <ul className="grid gap-1">
        {shown.map((a) => {
          const waiting = subagentWaiting(a, permission)
          const tool = a.tool?.replace(/^mcp__(.+?)__/, '$1·') ?? ''
          const since = a.running && a.tool_at ? fmtRun(Math.max(0, now - a.tool_at)) : ''
          return (
            <li key={a.agent_id} className="grid gap-0.5 rounded-[8px] border border-[var(--app-hairline)] px-2 py-1.5" data-waiting={waiting ? 'true' : undefined}
              title={[a.agent_type, a.description, a.tool && `${a.tool}${a.detail ? ` ${a.detail}` : ''}`].filter(Boolean).join(' — ')}>
              <p className="flex min-w-0 items-center gap-1.5 text-[12px]">
                <span className="shrink-0 text-fg-faint"><KindIcon kind="agent" size={12} /></span>
                <span className="shrink-0 font-medium text-fg">{a.agent_type || 'subagent'}</span>
                {a.description && <span className="min-w-0 truncate text-fg-muted">· {a.description}</span>}
                {waiting && <span className="ml-auto shrink-0 rounded-[4px] bg-accent/15 px-1.5 text-[10.5px] font-medium text-accent">waiting on you</span>}
              </p>
              <p className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-1.5 text-[11.5px]">
                {a.tool ? <span className={a.running ? 'text-ok' : 'text-fg-faint'}><KindIcon kind={toolKind(a.tool)} size={12} /></span> : <span />}
                <span className="min-w-0 truncate">
                  {a.tool ? (
                    <>
                      <span className={a.running ? 'text-fg' : 'text-fg-muted'}>{tool}</span>
                      {a.detail && <span className="mono ml-1 text-[11px] text-fg-muted">{a.detail}</span>}
                    </>
                  ) : <span className="text-fg-faint">starting</span>}
                </span>
                <span className="num text-[11px] text-fg-faint">
                  {since && <span className="text-ok">{since} · </span>}{a.tool_calls} {a.tool_calls === 1 ? 'call' : 'calls'}
                </span>
              </p>
            </li>
          )
        })}
      </ul>
      {hidden > 0 && <p className="text-[11px] text-fg-faint">+{hidden} more</p>}
    </section>
  )
}

function capital(t: string): string {
  return t ? t[0]!.toUpperCase() + t.slice(1) : t
}

function LoopWarning({ s, now }: { s: SessionSummary; now: number }) {
  const l = s.loop!
  return (
    <section aria-label="Loop alert" role="alert" className="grid gap-1 rounded-[10px] border border-danger/40 bg-danger/[0.07] px-3 py-2.5">
      <p className="flex items-baseline gap-2 text-[12.5px] font-medium text-danger">
        <span>Same {l.tool} call ×{l.count}</span>
        <span className="ml-auto text-[11px] font-normal text-fg-faint">{fmtAgo(l.last_ts || l.ts, now)}</span>
      </p>
      {l.sample && <p className="mono truncate text-[11.5px] text-fg-muted" title={l.sample}>{l.sample}</p>}
      <p className="text-[11.5px] text-fg-muted">
        within {l.window_min} min{typeof l.tax_usd === 'number' && l.tax_usd > 0 ? <> · re-reading the context for them cost <span className="num text-fg">{fmtUSD(l.tax_usd)}</span></> : null}
      </p>
    </section>
  )
}

function PlanWindows({ limits, agent, now }: { limits: NonNullable<Summary['rate_limits']>; agent?: string; now: number }) {
  const source = agent === 'codex' ? 'Codex' : 'Claude Code'
  return (
    <section aria-label="Plan limits" className="grid gap-2">
      <SectionLabel right={<span className="text-fg-faint">all {source} sessions</span>}>Plan</SectionLabel>
      {limits.five_hour && <WindowBar label="5-hour" w={limits.five_hour} now={now} source={source} />}
      {limits.seven_day && <WindowBar label="Weekly" w={limits.seven_day} now={now} source={source} />}
    </section>
  )
}

function WindowBar({ label, w, now, source }: { label: string; w: RateWindow; now: number; source: string }) {
  const { pct, stale } = readWindow(w, now)
  const resetMs = w.resets_at * 1000
  const tone = pct > 85 ? 'danger' : pct >= 60 ? 'warn' : 'accent'
  const observed = w.observed_at ? ` · read ${fmtAgo(w.observed_at, now)}` : ''
  return (
    <div className="grid grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5">
      <span className="text-[11.5px] text-fg-muted">{label}</span>
      <div className="cockpit-track h-[6px] overflow-hidden rounded-full" role="meter" aria-label={`${label} window used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="cockpit-fill h-full rounded-full" data-tone={tone} style={{ width: `${Math.max(1.5, Math.min(100, pct))}%` }} />
      </div>
      <span className={`num text-right text-[12px] font-medium ${tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-fg'}`}>{pct}%</span>
      <span />
      <span className="col-span-2 text-[10.5px] text-fg-faint" title={stale ? `${source} has not refreshed this window recently` : undefined}>
        {stale ? 'reset time stale' : `resets ${resetClock(resetMs, now)} · in ${countdown(resetMs - now)}`}{observed}
        {w.forecast && <span className="text-warn"> · {w.forecast}</span>}
      </span>
    </div>
  )
}

function Timeline({ runs, total, now }: { runs: ToolRun[]; total?: number; now: number }) {
  const rows = runs.slice(-TIMELINE_ROWS).reverse()
  const durations = rows.map((r) => Math.max(0, (r.endMs ?? now) - r.startMs))
  const max = Math.max(...durations, 1)
  return (
    <section aria-label="Recent tool calls" className="grid gap-2">
      <SectionLabel right={typeof total === 'number' && total > 0 ? <span className="num text-fg-faint">{total} in all</span> : undefined}>Recent tools</SectionLabel>
      {rows.length === 0 ? (
        <p className="text-[11.5px] text-fg-faint">No tool calls yet.</p>
      ) : (
        <ol className="grid">
          {rows.map((r, i) => {
            const ms = durations[i]!
            const live = r.endMs === undefined
            return (
              <li key={r.id} className="cockpit-row grid grid-cols-[18px_minmax(0,1fr)_34px_42px] items-center gap-2 py-[5px]" data-live={live ? 'true' : undefined} title={`${r.tool}${r.detail ? ` — ${r.detail}` : ''} · ${new Date(r.startMs).toLocaleTimeString()}`}>
                <span className={`grid place-items-center ${r.failed ? 'text-danger' : r.kind === 'edit' ? 'text-accent' : 'text-fg-muted'}`}><KindIcon kind={r.kind} size={14} /></span>
                <span className="min-w-0 truncate text-[12px]">
                  <span className={r.failed ? 'text-danger' : 'text-fg'}>{r.tool.startsWith('mcp__') ? r.tool.replace(/^mcp__(.+?)__/, '$1·') : r.tool}</span>
                  {r.detail && <span className="mono ml-1.5 text-[11px] text-fg-muted">{r.detail}</span>}
                </span>
                <span className="h-[3px] overflow-hidden rounded-full bg-[var(--app-hairline)]" aria-hidden>
                  <span className={`block h-full rounded-full ${r.failed ? 'bg-danger' : live ? 'cockpit-bar-live bg-ok' : 'bg-fg-faint'}`} style={{ width: `${runShare(ms, max) * 100}%` }} />
                </span>
                <span className={`num text-right text-[11px] ${live ? 'text-ok' : r.failed ? 'text-danger' : 'text-fg-muted'}`}>{live ? fmtRun(ms) : r.failed ? 'failed' : fmtRun(ms)}</span>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

type IconKind = ToolKind | 'think' | 'loop' | 'stop' | 'pause'

/** A tool's kind as a line glyph on the app's 24px grid. */
function KindIcon({ kind, size = 15 }: { kind: IconKind; size?: number }) {
  const path = ICON_PATHS[kind]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      {path}
    </svg>
  )
}

const ICON_PATHS: Record<IconKind, ReactNode> = {
  edit: <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4" />,
  read: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h4" /></>,
  run: <><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="m7 10 3 2.5L7 15M12.5 15H17" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>,
  web: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.5 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.5-3.5-8.5s1-5.9 3.5-8.5z" /></>,
  agent: <><circle cx="9" cy="9" r="3" /><circle cx="17" cy="10" r="2.3" /><path d="M3.5 19c.6-3 2.8-5 5.5-5s4.9 2 5.5 5M15 14.6c2.6-.5 4.8 1.2 5.5 4.4" /></>,
  plan: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3.5 6 1.3 1.3L7 5M3.5 12l1.3 1.3L7 11" /><circle cx="5" cy="18" r="1" /></>,
  ask: <><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01" /></>,
  mcp: <><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" /></>,
  other: <><circle cx="12" cy="12" r="2.2" /><circle cx="12" cy="12" r="8" /></>,
  think: <><path d="M12 3.5 13.8 9l5.7.2-4.5 3.4 1.6 5.5L12 14.8 7.4 18l1.6-5.5-4.5-3.4L10.2 9z" /></>,
  loop: <><path d="M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5" /></>,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  pause: <path d="M9 6.5v11M15 6.5v11" />,
}
