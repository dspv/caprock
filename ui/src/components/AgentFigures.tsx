/**
 * The Pipeline's agent figures (.ai/04-ui.md § Pipeline): what an hour of
 * agent work costs in this repository, and how big its agent team is — two
 * tiles at the end of the Flow row, drawn as its figures are (Stat, the
 * Today cells' line, a caption under it), and the team's daily chart that
 * the team tile opens. lib/repoagents says what each figure is.
 */
import { useState, type ReactNode } from 'react'
import { api, type RepoAgents, type TeamDay } from '@/lib/api'
import { fmtUSD } from '@/lib/format'
import { KIND_NAME, perHour, rateCompare, rateTokensText, rateWord, teamDayTitle, teamOf } from '@/lib/repoagents'
import { CI_IDLE_MS, usePoll } from '@/lib/usePoll'
import { Panel, Stat } from './ui'

/** The repository's agent figures, read while `on`, once a minute. */
export function useRepoAgents(roots: readonly string[], on: boolean) {
  const key = roots.join('\n')
  return usePoll<RepoAgents>(on && roots.length > 0, key, () => api.pipelineAgents([...roots]), () => false, CI_IDLE_MS, roots.length ? `agents:${key}` : undefined)
}

const LIST_PRICE = 'at API list price · estimate'

/**
 * The Agents card of the Flow row: the cost on these pull requests big, and
 * "$13.85/h · 2 now · peak 7" under it. The first part is the last 24 hours'
 * cost per agent-hour, the second opens the team's daily chart. Everything
 * the old cost-per-hour and team tiles said is in the hover.
 */
export function AgentsCard({ cost, costHint, trend, a, open, onToggle }: {
  cost: number; costHint: string; trend?: ReactNode; a?: RepoAgents; open: boolean; onToggle: () => void
}) {
  const hint = (
    <>
      <b>Agent cost</b>: {costHint}
      {a && <>
        <br /><b>Cost per agent-hour</b>, the last 24 hours, {LIST_PRICE}. An hour of work is one agent session’s clock hour with five or more priced calls, its subagents included; per agent-hour, not per wall-clock hour: four agents at once are four hours of work.
        {' '}{rateTokensText(a)} · {rateWord(rateCompare(a), a.days)}.
        <br /><b>Agent team</b>: the agents with a turn in the last ten minutes, main sessions and their subagents, and today’s most at once. Press “now” for the chart by day.
      </>}
    </>
  )
  const rate = a ? perHour(a.rate.last24) : undefined
  const t = a?.team
  return (
    <Stat data="agents" label="Agents · 14 days" size="compact" value={fmtUSD(cost)} trend={trend} hint={hint}
      sub={<span className="mono">
        {a ? <>
          <span data-agent-rate title={`Cost per agent-hour, the last 24 hours, ${LIST_PRICE}`}>{rate === undefined ? '–' : `${fmtUSD(rate)}/h`}</span>
          {t && <>
            {' · '}
            <button type="button" onClick={onToggle} aria-expanded={open} data-team-toggle
              title={`Now: ${t.now.sessions} session${t.now.sessions === 1 ? '' : 's'} and ${t.now.subagents} subagent${t.now.subagents === 1 ? '' : 's'}. Press for the chart by day`}
              className={`rounded-[3px] outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-accent ${open ? 'text-fg underline' : ''}`}>
              {t.now.sessions + t.now.subagents} now · peak {t.peak_today}
            </button>
          </>}
        </> : <span title={costHint}>{LIST_PRICE}</span>}
      </span>} />
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
