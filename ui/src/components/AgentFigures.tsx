/**
 * The Pipeline's agent figures (.ai/04-ui.md § Pipeline): what an hour of
 * agent work costs in this repository, and how big its agent team is — two
 * tiles at the end of the Flow row, drawn as its figures are (Stat, the
 * Today cells' line, a caption under it), and the team's daily chart that
 * the team tile opens. lib/repoagents says what each figure is.
 */
import { useState } from 'react'
import { api, type RepoAgents, type TeamDay } from '@/lib/api'
import { fmtUSD } from '@/lib/format'
import { KIND_NAME, perHour, perWallHour, rateCompare, rateCompareTitle, rateDayTitle, rateTokensText, rateWord, teamDayTitle, teamOf, teamUsual, teamWord } from '@/lib/repoagents'
import { CI_IDLE_MS, usePoll } from './SessionDeck'
import { TrendLine } from './TodayTrend'
import { Panel, Stat } from './ui'

/** The repository's agent figures, read while `on`, once a minute. */
export function useRepoAgents(roots: readonly string[], on: boolean) {
  const key = roots.join('\n')
  return usePoll<RepoAgents>(on && roots.length > 0, key, () => api.pipelineAgents([...roots]), () => false, CI_IDLE_MS, roots.length ? `agents:${key}` : undefined)
}

const LIST_PRICE = 'at API list price · estimate'

/** The cost-per-hour tile. */
export function CostHourStat({ a }: { a: RepoAgents }) {
  const now = perHour(a.rate.last24)
  const c = rateCompare(a)
  const usual = perHour(a.rate.usual)
  const s = a.rate.series
  const wall = perWallHour(a.rate.last24)
  const hint = (
    <>
      <b>Cost per agent-hour</b>, the last 24 hours, {LIST_PRICE}. An hour of work is one agent session’s clock hour with five or more priced calls, its subagents included — the rule the session’s burn rate is set against; spend in an hour touched in passing is in the total, not the rate.
      {' '}Per agent-hour, not per wall-clock hour: four agents at once are four hours of work.
      {wall !== undefined && <> Per wall-clock hour with any agent at work: {fmtUSD(wall)}/h over {a.rate.last24.wall_hours} h.</>}
      {' '}Set against the {a.days}×24 hours before, pooled; the line is the last {s.length} days.
    </>
  )
  return (
    <Stat data="agent-hour" label="Cost / agent-hour" size="compact" hint={hint}
      value={now === undefined ? '–' : <>{fmtUSD(now)}<span className="text-[13px] font-medium text-fg-muted">/h</span></>}
      sub={<>{rateTokensText(a)}<br />{LIST_PRICE}</>}
      trend={s.length > 1 ? (
        <div className="mt-1 min-w-0" data-trend="agent-hour">
          <TrendLine pts={s.map((d) => perHour(d))} titles={s.map((d, i) => rateDayTitle(d, i === s.length - 1))} usual={usual} dot="bg-fg-muted"
            label={`Cost per agent-hour, last ${s.length} days, today last`} isolated />
          <div className="mt-0.5 h-[15px] truncate text-[11px] leading-[15px] num" data-compare={c.kind} title={rateCompareTitle(c, a)}>
            <span className={c.kind === 'thin' || c.kind === 'quiet' ? 'text-fg-faint' : 'text-fg-muted'}>{rateWord(c, a.days)}</span>
          </div>
        </div>
      ) : undefined} />
  )
}

/** The agent-team tile; a press opens the daily chart. */
export function TeamStat({ a, open, onToggle }: { a: RepoAgents; open: boolean; onToggle: () => void }) {
  const t = a.team
  const nowN = t.now.sessions + t.now.subagents
  const series = t.series.slice(-(a.days + 1))
  const u = teamUsual(t.series, a.days)
  const today = t.series[t.series.length - 1]
  const hint = (
    <>
      <b>Agent team</b>: the agents with a turn in the last ten minutes — main sessions and their subagents, each subagent counted on its own — and today’s most at once, in any five minutes.
      {' '}The line is distinct agents a day, like contributors; the caption the {a.days}-day average over the days anyone worked, and the busiest day. Press for the chart by day.
    </>
  )
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} data-team-toggle
      className={`h-full min-w-0 text-left outline-none transition-colors hover:bg-[var(--app-row-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent motion-reduce:transition-none ${open ? 'bg-[var(--app-row-hover)]' : ''}`}>
      <Stat data="agent-team" label="Agent team" size="compact" hint={hint}
        value={<>{nowN}<span className="text-[13px] font-medium text-fg-muted"> now</span></>}
        sub={<span title={`Now: ${t.now.sessions} session${t.now.sessions === 1 ? '' : 's'} and ${t.now.subagents} subagent${t.now.subagents === 1 ? '' : 's'}. Today: ${today ? teamOf(today) : 0} agents in all, at most ${t.peak_today} at once`}>{t.now.sessions} + {t.now.subagents} sub · peak {t.peak_today} today</span>}
        trend={series.length > 1 ? (
          <div className="mt-1 min-w-0" data-trend="agent-team">
            <TrendLine pts={series.map(teamOf)} titles={series.map((d, i) => teamDayTitle(d, i === series.length - 1))}
              usual={'thin' in u ? undefined : u.avg} dot="bg-fg-muted" label={`Agents a day, last ${series.length} days, today last`} />
            <div className="mt-0.5 h-[15px] truncate text-[11px] leading-[15px] num" data-compare={'thin' in u ? 'thin' : 'usual'}
              title={'thin' in u ? `Not enough history: ${u.days} of the previous ${a.days} days had an agent at work` : `The ${a.days}-day average over the ${u.days} days with an agent at work; the busiest was ${u.peakDay}`}>
              <span className={'thin' in u ? 'text-fg-faint' : 'text-fg-muted'}>{teamWord(u)}</span>
            </div>
          </div>
        ) : undefined} />
    </button>
  )
}

/**
 * The team by day as stacked bars — main sessions under, subagents over —
 * like a contributors chart; hovering a day says it, split by agent kind.
 */
export function TeamChart({ a, onClose }: { a: RepoAgents; onClose: () => void }) {
  const days = a.team.series
  const [hover, setHover] = useState<number>()
  const max = Math.max(1, ...days.map(teamOf))
  const shown = hover !== undefined ? days[hover] : undefined
  return (
    <Panel title={`Agent team · last ${days.length} days`} right={
      <span className="flex items-center gap-3">
        <span className="flex items-center gap-1.5"><span aria-hidden className="inline-block h-2 w-2 rounded-[2px] bg-accent" />sessions</span>
        <span className="flex items-center gap-1.5"><span aria-hidden className="inline-block h-2 w-2 rounded-[2px] bg-accent/40" />subagents</span>
        <button type="button" onClick={onClose} aria-label="Close the agent team chart" className="rounded-[5px] px-1.5 text-[15px] leading-[18px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">×</button>
      </span>
    }>
      <div data-team-chart className="px-3 pb-2 pt-3">
        <div className="mb-1.5 h-[34px] text-[12px] leading-[17px] text-fg-muted" aria-live="polite">
          {shown ? <span className="whitespace-pre-line">{teamDayTitle(shown, hover === days.length - 1)}</span>
            : <>Peak day: {Math.max(...days.map(teamOf))} agents · today {teamOf(days[days.length - 1]!)} so far. Hover a day for its split by agent kind.</>}
        </div>
        <div className="flex h-[120px] items-end gap-[2px]" role="img" aria-label={`Distinct agents a day, last ${days.length} days`} onMouseLeave={() => setHover(undefined)}>
          {days.map((d, i) => <Bar key={d.day} d={d} max={max} on={hover === i} onHover={() => setHover(i)} today={i === days.length - 1} />)}
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-fg-faint num">
          <span>{days[0]?.day.slice(5)}</span><span>today</span>
        </div>
        <table className="sr-only">
          <caption>Agents a day</caption>
          <thead><tr><th>Day</th><th>Sessions</th><th>Subagents</th><th>Most at once</th><th>By kind</th></tr></thead>
          <tbody>{days.map((d) => (
            <tr key={d.day}><td>{d.day}</td><td>{d.sessions}</td><td>{d.subagents}</td><td>{d.peak}</td>
              <td>{Object.entries(d.by_kind ?? {}).map(([k, c]) => `${KIND_NAME[k] ?? k} ${c.sessions}+${c.subagents}`).join(', ')}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </Panel>
  )
}

function Bar({ d, max, on, onHover, today }: { d: TeamDay; max: number; on: boolean; onHover: () => void; today: boolean }) {
  const h = (n: number) => `${(n / max) * 100}%`
  return (
    // The hover target is the whole column, taller than the bar.
    <div className="flex h-full min-w-0 flex-1 flex-col justify-end" onMouseEnter={onHover} title={teamDayTitle(d, today)} data-team-day={d.day}>
      {d.subagents > 0 && <div className={`w-full rounded-t-[3px] ${on ? 'bg-accent/60' : 'bg-accent/40'}`} style={{ height: h(d.subagents) }} />}
      {d.sessions > 0 && <div className={`w-full ${d.subagents > 0 ? 'mt-[2px]' : 'rounded-t-[3px]'} ${on ? 'bg-accent' : 'bg-accent/85'}`} style={{ height: h(d.sessions) }} />}
      {teamOf(d) === 0 && <div className="h-px w-full bg-border" />}
    </div>
  )
}
