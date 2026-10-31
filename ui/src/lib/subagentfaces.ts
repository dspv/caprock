/**
 * The hero's subagent frame drawn with the brand characters (.ai/04-ui.md §
 * Inspector, the subagent chart). Three looks, per viewer:
 *
 * - **chart** (the default), *Chart of faces*: the hour in five-minute
 *   columns, each a stack of faces as tall as the most subagents at once in
 *   it;
 * - **crew**, *Crew*: one face per working subagent, the finished faded;
 * - **numbers**, *Numbers*: the crowd large and the figures big.
 *
 * Owner, 2026-10-31 (translated): the old step line "looks poor"; build it
 * from our characters, three variants, the chart by default, "maybe someone
 * will like another one". The arithmetic lives here so it is tested apart
 * from the component.
 */
import { useSyncExternalStore } from 'react'
import { hashedFace, isPool, type Face, type FaceDefault } from '@/lib/faces'
import type { SubagentHour } from '@/lib/api'

export type SubagentLook = 'chart' | 'crew' | 'numbers'

export const SUBAGENT_LOOKS: readonly { id: SubagentLook; name: string }[] = [
  { id: 'chart', name: 'Chart of faces' },
  { id: 'crew', name: 'Crew' },
  { id: 'numbers', name: 'Numbers' },
]

export const DEFAULT_SUBAGENT_LOOK: SubagentLook = 'chart'
export const SUBAGENT_LOOK_KEY = 'caprock.app.subagent-look'

export function isSubagentLook(v: unknown): v is SubagentLook {
  return v === 'chart' || v === 'crew' || v === 'numbers'
}

let current: SubagentLook | undefined
const listeners = new Set<() => void>()

export function getSubagentLook(): SubagentLook {
  if (current) return current
  try {
    const v = localStorage.getItem(SUBAGENT_LOOK_KEY)
    current = isSubagentLook(v) ? v : DEFAULT_SUBAGENT_LOOK
  } catch {
    current = DEFAULT_SUBAGENT_LOOK
  }
  return current
}

export function setSubagentLook(look: SubagentLook): void {
  current = look
  try {
    localStorage.setItem(SUBAGENT_LOOK_KEY, look)
  } catch {
    // Private storage: the choice holds until the window closes.
  }
  for (const fn of listeners) fn()
}

/** For tests: forget what was read, so the next read is from storage. */
export function resetSubagentLookForTest(): void {
  current = undefined
}

export function useSubagentLook(): SubagentLook {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    getSubagentLook,
    getSubagentLook,
  )
}

/** Minutes per column of the chart of faces. */
export const BUCKET_MINUTES = 5
/** Columns in the chart: an hour of five-minute columns. */
export const BUCKETS = 12
/** The tallest stack of faces; past it one face stands for several subagents. */
export const MAX_STACK = 6

/** One column of the chart: its first minute (unix ms) and the most at work at once in it. */
export interface FaceBucket { start: number; most: number }

/**
 * The hour's per-minute counts as twelve five-minute columns on the clock
 * (:00, :05, … — so a minute stays in its column as the hour moves on and
 * the faces stand still), the newest the one now is in, possibly partial.
 * Each holds the most at work in any of its minutes. Minutes older than the
 * first column (at most four) are left out.
 */
export function faceBuckets(hour: Pick<SubagentHour, 'start' | 'step_ms' | 'counts'>): FaceBucket[] {
  const step = hour.step_ms > 0 ? hour.step_ms : 60_000
  const span = step * BUCKET_MINUTES
  const lastMinute = hour.start + Math.max(0, hour.counts.length - 1) * step
  const first = (Math.floor(lastMinute / span) - (BUCKETS - 1)) * span
  const out: FaceBucket[] = Array.from({ length: BUCKETS }, (_, j) => ({ start: first + j * span, most: 0 }))
  hour.counts.forEach((v, i) => {
    const at = hour.start + i * step
    const j = Math.floor((at - first) / span)
    if (j >= 0 && j < BUCKETS && v > out[j]!.most) out[j]!.most = v
  })
  return out
}

/** The minute of the peak (unix ms): the latest minute that reached it; undefined with no peak. */
export function peakMinute(hour: Pick<SubagentHour, 'start' | 'step_ms' | 'counts' | 'peak'>): number | undefined {
  if (hour.peak <= 0) return undefined
  for (let i = hour.counts.length - 1; i >= 0; i--) if (hour.counts[i]! >= hour.peak) return hour.start + i * hour.step_ms
  return undefined
}

/** Local time as HH:MM, 24-hour, whatever the locale. */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** How many subagents one face stands for: one, or ceil(peak / 6) past a peak of six. */
export function faceScale(peak: number): number {
  return peak > MAX_STACK ? Math.ceil(peak / MAX_STACK) : 1
}

/** How many faces a column of `most` subagents stacks at that scale (any at all shows one). */
export function stackHeight(most: number, scale: number): number {
  return most > 0 ? Math.ceil(most / Math.max(1, scale)) : 0
}

/**
 * The face a subagent wears: the one the viewer chose for Claude in
 * Settings, or, when that is a random pool, one from the pool picked by the
 * key's hash — the same key, the same face, on every render.
 */
export function subagentFace(key: string, d: FaceDefault): Face {
  return isPool(d) ? hashedFace(key, d) : d
}
