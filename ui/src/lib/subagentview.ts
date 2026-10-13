/**
 * The cockpit's Subagents rows as each viewer has set them (.ai/04-ui.md §
 * Inspector): which figures a row shows under its phrase, and the order the
 * rows stand in. Kept apart from the component so both are tested.
 *
 * Owner, 2026-10-14 (translated): "the text doesn't show enough, and they
 * jump — their order jumps too, I want fixed positions. And there's calls,
 * dollars, model and time. Maybe a switch for what to see?"
 */
import { useSyncExternalStore } from 'react'

/** A figure a subagent row can show under its phrase. */
export type SubagentField = 'calls' | 'cost' | 'model' | 'time'

export type SubagentFields = Readonly<Record<SubagentField, boolean>>

/** The figures in the order a row writes them, with their menu names. */
export const SUBAGENT_FIELDS: readonly { id: SubagentField; name: string; hint: string }[] = [
  { id: 'calls', name: 'Calls', hint: 'tool calls it has made' },
  { id: 'cost', name: 'Cost', hint: 'what its own calls cost' },
  { id: 'model', name: 'Model', hint: 'the model of its newest turn' },
  { id: 'time', name: 'Time', hint: 'how long it has worked' },
]

export type SubagentPreset = 'compact' | 'cost' | 'full'

/** Three ready choices: just the phrase, cost and time, everything. */
export const SUBAGENT_PRESETS: readonly { id: SubagentPreset; name: string; fields: SubagentFields }[] = [
  { id: 'compact', name: 'Compact', fields: { calls: false, cost: false, model: false, time: false } },
  { id: 'cost', name: 'Cost', fields: { calls: false, cost: true, model: false, time: true } },
  { id: 'full', name: 'Full', fields: { calls: true, cost: true, model: true, time: true } },
]

/** Before a viewer picks: cost and time, the two that answer "is it worth it". */
export const DEFAULT_SUBAGENT_FIELDS: SubagentFields = SUBAGENT_PRESETS[1]!.fields

/** The preset these fields match, if any. */
export function presetOf(f: SubagentFields): SubagentPreset | undefined {
  return SUBAGENT_PRESETS.find((p) => SUBAGENT_FIELDS.every(({ id }) => p.fields[id] === f[id]))?.id
}

/** Whatever was stored, made valid field by field; a missing field takes its default. */
export function normalizeSubagentFields(raw: unknown): SubagentFields {
  const v = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const out: Record<SubagentField, boolean> = { ...DEFAULT_SUBAGENT_FIELDS }
  for (const { id } of SUBAGENT_FIELDS) {
    const b = v[id]
    if (typeof b === 'boolean') out[id] = b
  }
  return out
}

export const SUBAGENT_FIELDS_KEY = 'caprock.app.subagent-fields'

let current: SubagentFields | undefined
const listeners = new Set<() => void>()

export function getSubagentFields(): SubagentFields {
  if (current) return current
  try {
    const s = localStorage.getItem(SUBAGENT_FIELDS_KEY)
    current = normalizeSubagentFields(s ? JSON.parse(s) : undefined)
  } catch {
    current = DEFAULT_SUBAGENT_FIELDS
  }
  return current
}

export function setSubagentFields(patch: Partial<Record<SubagentField, boolean>>): void {
  current = normalizeSubagentFields({ ...getSubagentFields(), ...patch })
  try {
    localStorage.setItem(SUBAGENT_FIELDS_KEY, JSON.stringify(current))
  } catch {
    // Private storage: the choice holds until the window closes.
  }
  for (const fn of listeners) fn()
}

/** For tests: forget what was read, so the next read is from storage. */
export function resetSubagentFieldsForTest(): void {
  current = undefined
}

export function useSubagentFields(): SubagentFields {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    getSubagentFields,
    getSubagentFields,
  )
}

/**
 * Rows in a fixed order: by when each subagent started, first on top, its
 * id breaking a tie. The start is the one seen first, kept in `seen` (agent
 * id → start, unix ms): the daemon's start is the first event inside its
 * live window, which moves for one that runs longer than the window, and a
 * row must not move with it. Nothing that changes while it works — its
 * state, its activity, its cost, finishing — is read, so a new subagent
 * lands last and a finished one keeps its place.
 */
export function orderSubagents<T extends { agent_id: string; started_at: number }>(items: readonly T[], seen: Map<string, number>): T[] {
  for (const it of items) if (!seen.has(it.agent_id)) seen.set(it.agent_id, it.started_at)
  const start = (it: T) => seen.get(it.agent_id) ?? it.started_at
  return [...items].sort((a, b) => start(a) - start(b) || (a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0))
}
