/**
 * The hero's subagents drawn with the brand characters (.ai/04-ui.md §
 * Inspector, the subagent chart). Three looks, per viewer:
 *
 * - **matrix** (the default), *Matrix*: no frame; at the left of the
 *   figures the session's portrait large and the subagents' faces in a
 *   grid of four columns and two rows beside it, the working in colour,
 *   the finished grey, seven and *+N* past eight;
 * - **chips**, *Faces as chips*: the row of chips under the figures are the
 *   subagents' faces, *1 working · peak 4* beside them opens the hour's
 *   chart;
 * - **strip**, *Strip*: one line, the working faces big and breathing, the
 *   finished small and grey, a sparkline of the hour at the right.
 *
 * Owner, 2026-10-31 (translated): the old step line "looks poor"; build it
 * from our characters. 2026-11-06 (translated): "fun, but takes far too much
 * space": the chart of faces and the numbers look were dropped for the
 * strip and the chips. Later that day (translated): "on the right I just
 * want a matrix of agent thumbnails and the main agent's icon, that's all —
 * and swap: pictures on the left, figures on the right": the matrix took
 * the crew's place and became the default. The arithmetic lives here so it
 * is tested apart from the component.
 */
import { useSyncExternalStore } from 'react'
import { hashedFace, isPool, type Face, type FaceDefault } from '@/lib/faces'
import type { SubagentHour } from '@/lib/api'

export type SubagentLook = 'matrix' | 'chips' | 'strip'

export const SUBAGENT_LOOKS: readonly { id: SubagentLook; name: string }[] = [
  { id: 'matrix', name: 'Matrix' },
  { id: 'chips', name: 'Faces as chips' },
  { id: 'strip', name: 'Strip' },
]

export const DEFAULT_SUBAGENT_LOOK: SubagentLook = 'matrix'
export const SUBAGENT_LOOK_KEY = 'caprock.app.subagent-look'

/**
 * The most tiles the matrix draws, its *+N* included: two rows of four, so
 * the grid is never taller than the portrait beside it (owner, 2026-11-06,
 * translated: "this needs to be made symmetric"). Past eight, seven faces
 * and *+N*.
 */
export const MATRIX_TILES = 8

/** How many faces the matrix draws: eight, or seven and *+N* when more than eight work. */
export function matrixRoom(working: number): number {
  return working > MATRIX_TILES ? MATRIX_TILES - 1 : MATRIX_TILES
}

export function isSubagentLook(v: unknown): v is SubagentLook {
  return v === 'matrix' || v === 'chips' || v === 'strip'
}

/**
 * A stored look as it reads today: the crew, dropped on 2026-11-06, became
 * the matrix that replaced it; anything else unknown (the chart of faces,
 * the numbers, garbage) is the default.
 */
export function readSubagentLook(v: unknown): SubagentLook {
  if (v === 'crew') return 'matrix'
  return isSubagentLook(v) ? v : DEFAULT_SUBAGENT_LOOK
}

let current: SubagentLook | undefined
const listeners = new Set<() => void>()

export function getSubagentLook(): SubagentLook {
  if (current) return current
  try {
    current = readSubagentLook(localStorage.getItem(SUBAGENT_LOOK_KEY))
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

/** Minutes in the newest stretch of the hour's chart drawn in full; the older are dimmed. */
export const FRESH_MINUTES = 10

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

/**
 * The hour's per-minute counts as a sparkline's points in a box `w` by `h`,
 * scaled to the peak, oldest at the left; a flat line along the bottom when
 * none worked.
 */
export function sparkPoints(counts: readonly number[], peak: number, w: number, h: number): string {
  const n = counts.length
  if (n === 0) return `0,${h} ${w},${h}`
  const top = Math.max(1, peak)
  const x = (i: number) => (n === 1 ? w : (i / (n - 1)) * w)
  return counts.map((v, i) => `${round(x(i))},${round(h - (Math.max(0, v) / top) * (h - 1) - 0.5)}`).join(' ')
}

function round(v: number): number {
  return Math.round(v * 10) / 10
}

/** "1 working · peak 4": the working now and, when any worked in the hour, the most at once. */
export function subagentSummary(working: number, hour: Pick<SubagentHour, 'peak'> | undefined): string {
  return hour && hour.peak > 0 ? `${working} working · peak ${hour.peak}` : `${working} working`
}

/**
 * The face a subagent wears: the one the viewer chose for Claude in
 * Settings, or, when that is a random pool, one from the pool picked by the
 * key's hash — the same key, the same face, on every render.
 */
export function subagentFace(key: string, d: FaceDefault): Face {
  return isPool(d) ? hashedFace(key, d) : d
}
