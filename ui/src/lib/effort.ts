/**
 * The reasoning effort a new session starts at (New agent, on this computer
 * and on another). Only for the agents whose CLI takes one at launch: the
 * catalog (`GET /v1/agents/catalog`, read from the computer the agent runs
 * on) lists their levels as `efforts`, and the level the agent would use on
 * its own as `effort_default` or, per model, `model_efforts`.
 *
 * The control pre-selects that default and marks it; keeping it passes
 * nothing, so the agent's own setting stays in charge. Only a different pick
 * is sent (owner, 2026-11-23). The last pick is kept per agent for this
 * viewer, as a convenience: a lost one starts on the default again.
 */
import { useEffect, useState } from 'react'
import type { CatalogEntry } from './api'

/** The levels, short: the control sits beside Model on one row. */
export const EFFORT_SHORT: Record<string, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

export const EFFORT_WORDS: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'extra high',
  max: 'max',
}

/** The effort `entry`'s agent would start `model` at with nothing passed, or
 *  '' when that cannot be told. `model` '' is the agent's own default model. */
export function effortDefault(entry: CatalogEntry | undefined, model: string): string {
  if (!entry?.efforts?.length) return ''
  if (entry.effort_default) return entry.effort_default
  const per = entry.model_efforts ?? {}
  const m = model.trim() || entry.default || ''
  return (m && per[m]) || ''
}

/** What a start sends: the pick when it differs from the default, else nothing. */
export function effortToSend(pick: string, def: string): string | undefined {
  return pick && pick !== def ? pick : undefined
}

export const EFFORT_KEY = 'caprock.spawn.effort'

function loadAll(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(EFFORT_KEY) ?? '{}') as unknown
    return v && typeof v === 'object' ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function loadEffort(agent: string): string {
  const v = loadAll()[agent]
  return typeof v === 'string' ? v : ''
}

export function saveEffort(agent: string, pick: string) {
  try {
    const all = loadAll()
    if (pick) all[agent] = pick
    else delete all[agent]
    localStorage.setItem(EFFORT_KEY, JSON.stringify(all))
  } catch { /* for this page only */ }
}

/**
 * The Effort control's state for one agent: its levels, the default for the
 * model chosen, what is shown selected, and what a start sends. `remember`
 * keeps the pick for the next start of the same agent, called once started.
 */
export function useEffortChoice(agent: string, entry: CatalogEntry | undefined, model: string) {
  const [picks, setPicks] = useState<Record<string, string>>({})
  useEffect(() => {
    setPicks((p) => (agent in p ? p : { ...p, [agent]: loadEffort(agent) }))
  }, [agent])
  const levels = entry?.efforts ?? []
  const def = effortDefault(entry, model)
  const stored = picks[agent] ?? ''
  const pick = levels.includes(stored) ? stored : ''
  const shown = pick || def
  const choose = (level: string) => setPicks((p) => ({ ...p, [agent]: level === def ? '' : level }))
  const send = effortToSend(pick, def)
  const remember = () => saveEffort(agent, pick)
  return { levels, def, shown, choose, send, remember }
}
