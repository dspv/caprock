/**
 * A session's phase, as the sidebar's Open rows say it in one coloured chip
 * (owner, 2026-11-05, translated: "it's unclear what is open where and in
 * which phase"; mockup V1). Five words, each from a signal the sidebar
 * already has — the row's dot (lib/sidebar.ts dotOf), which reads the
 * daemon's session health and the pending permission prompts:
 *
 * - **working** (green): its health is `working`.
 * - **needs you** (amber): a permission prompt is pending, or its health is
 *   `waiting-on-you` (a question, a plan to approve, its turn ended asking
 *   for something).
 * - **done** (blue): its health is `done` — the turn ended and nothing is
 *   pending (lib/needs.ts) — or the session has ended. The daemon does not
 *   tell a clean exit from a crash in the session list, so an ended session
 *   is done, as the row's state word has said since 2026-10 (ProjectRow
 *   STATE_WORD); a crash shows on its tab.
 * - **failed** (red): its health is `looping` or `error`.
 * - **idle** (grey): anything else — alive, quiet, nothing asked.
 *
 * A file, a browser page or the Files tab has no phase: no chip.
 */
import type { Dot, ProjectNode } from './sidebar'

export type Phase = 'working' | 'needs-you' | 'idle' | 'done' | 'failed'

/** The one mapping from a row's dot to its phase. */
export function phaseOf(dot: Dot): Phase {
  switch (dot) {
    case 'working': return 'working'
    case 'waiting': return 'needs-you'
    case 'done':
    case 'ended': return 'done'
    case 'looping': return 'failed'
    default: return 'idle'
  }
}

/** The chip's word. */
export const PHASE_WORD: Record<Phase, string> = {
  'working': 'working',
  'needs-you': 'needs you',
  'idle': 'idle',
  'done': 'done',
  'failed': 'failed',
}

/**
 * A folded project's short summary at its right (mockup V1): what needs you
 * first, else what works, else how many sit idle; nothing for a project with
 * no agent running. `tone` colours its dot: none for idle.
 */
export interface ProjectSummary {
  text: string
  tone?: 'warn' | 'ok'
}

export function projectSummary(n: Pick<ProjectNode, 'waiting' | 'working' | 'agents'>): ProjectSummary | undefined {
  if (n.waiting > 0) return { text: `${n.waiting} needs you`, tone: 'warn' }
  if (n.working > 0) return { text: `${n.working} running`, tone: 'ok' }
  if (n.agents > 0) return { text: `${n.agents} idle` }
  return undefined
}
