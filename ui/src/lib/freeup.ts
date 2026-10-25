/**
 * Free up memory (.ai/04-ui.md § Free up memory; owner, 2026-10-25): one
 * button for everything that can be freed and is safe to, the same in
 * Caprock resources and in the memory popover. It offers two groups:
 *
 * - **Leftovers**: what the doctor's scan lists and ticks by default
 *   (`safeToStop`) — test copies of Caprock whose agent is gone, commands
 *   whose window or script closed, finished sessions, their helpers. A test
 *   copy the daemon holds (`hold`: its agent is still running) is never in
 *   it; it stays on its row under Details.
 * - **Idle agents**: the agents Caprock started that the daemon calls
 *   `endable` — idle 15 minutes, nothing in the background, not the tab in
 *   front, not the orchestrator or a worker. The rest it started are
 *   listed as kept, each with the daemon's `why_not`.
 *
 * The daemon judges everything again when the click comes: the stop names
 * `skip_held`, the end names the tab in front.
 */
import type { SessionSummary } from './api'
import { cleanupList, doctorRows, plainName, safeToStop, startedFrom, age, type Footprint, type Orphan, type OrphanStopResult } from './footprint'
import { agentStateText, type EndIdleResult, type MemoryAgent, type MemoryReport } from './memory'
import { fmtMem } from './resources'
import { sessionTitle } from './sidebar'

/** One line of the confirmation: a leftover or an idle agent, with its own checkbox. */
export interface FreeUpItem {
  /** `o:<pid>` for a leftover, `a:<session id>` for an agent. */
  key: string
  group: 'leftovers' | 'agents'
  name: string
  /** Where it came from or how long it has idled. */
  detail: string
  mem_bytes: number
  orphan?: Orphan
  agent?: MemoryAgent
}

/** An agent Caprock started that is left running, and why, in words. */
export interface KeptAgent {
  session_id: string
  name: string
  why: string
}

export interface FreeUpPlan {
  leftovers: FreeUpItem[]
  agents: FreeUpItem[]
  /** Listed by the doctor but held by the daemon: a test copy whose agent is still running. */
  held: Orphan[]
  /** Idle agents Caprock started that are not offered, with why. */
  kept: KeptAgent[]
  /** What everything offered holds together. */
  mem_bytes: number
}

/** The idle-agent group's line, and the sentence above the list. */
export const AGENTS_LINE = 'Conversations are kept; Continue picks each up where it stopped.'
export const WHAT_HAPPENS = 'Leftovers are stopped and idle agents are ended. Anything an idle agent started in the background (a dev server, a watcher) stops with it.'

const agentName = (a: MemoryAgent, sessions?: Map<string, SessionSummary>) => {
  const s = sessions?.get(a.session_id)
  return s ? sessionTitle(s) : `agent · pid ${a.pid}`
}

/** The daemon's why_not, in the confirmation's words. */
export function keptWhy(a: MemoryAgent, now: number): string {
  const w = a.why_not ?? ''
  if (w === 'idle under 15 min') return `${agentStateText(a, now)}: offered after 15 min`
  if (w === 'the tab in front') return 'the tab in front'
  if (w.startsWith('running in the background: ')) return `still running ${w.slice('running in the background: '.length)} in the background`
  if (w === 'the orchestrator or one of its workers') return 'part of a running orchestration'
  return w || agentStateText(a, now)
}

/**
 * What Free up memory offers. `f` is a footprint with the doctor's orphan
 * list (scanned); `mem` is GET /v1/system/memory. Either may be missing
 * while it loads, or from an older daemon.
 */
export function freeUpPlan(f: Footprint | undefined, mem: MemoryReport | undefined, sessions?: SessionSummary[], now = Date.now()): FreeUpPlan {
  const byId = new Map((sessions ?? []).map((s) => [s.session_id, s]))
  const listed = f?.orphans?.scanned ? cleanupList(doctorRows(f)) : []
  const at = f?.at ?? now
  const leftovers: FreeUpItem[] = listed.filter(safeToStop).map((o) => ({
    key: `o:${o.pid}`, group: 'leftovers', name: plainName(o),
    detail: startedFrom(o.data_dir, o.exe) ?? `running ${age(at - o.started_at)}`,
    mem_bytes: o.mem_bytes, orphan: o,
  }))
  const held = listed.filter((o) => Boolean(o.hold))
  const owned = (mem?.agents ?? []).filter((a) => a.owned)
  const agents: FreeUpItem[] = owned.filter((a) => a.endable).map((a) => ({
    key: `a:${a.session_id}`, group: 'agents', name: agentName(a, byId),
    detail: agentStateText(a, mem?.at ?? now), mem_bytes: a.mem_bytes, agent: a,
  }))
  // Kept: the idle ones, whose reason is worth reading. One working or
  // waiting on you is plainly not offered.
  const kept = owned.filter((a) => !a.endable && a.state === 'idle')
    .map((a) => ({ session_id: a.session_id, name: agentName(a, byId), why: keptWhy(a, mem?.at ?? now) }))
  const mem_bytes = [...leftovers, ...agents].reduce((s, x) => s + x.mem_bytes, 0)
  return { leftovers, agents, held, kept, mem_bytes }
}

/** The button: "Free up memory · ~2.7 GB". */
export function freeUpLabel(bytes: number): string {
  return bytes > 0 ? `Free up memory · ~${fmtMem(bytes)}` : 'Free up memory'
}

/** The confirm button for what is ticked: "Free up 4 · ~2.1 GB". */
export function confirmLabel(n: number, bytes: number): string {
  return n === 0 ? 'Free up' : `Free up ${n}${bytes > 0 ? ` · ~${fmtMem(bytes)}` : ''}`
}

/** The faint line under Leftovers for what the daemon holds. */
export function heldLine(held: Orphan[]): string {
  const n = held.length
  const copies = held.every((o) => o.kind === 'caprock_daemon')
  const what = copies ? `${n} test ${n === 1 ? 'copy' : 'copies'} of Caprock` : `${n} ${n === 1 ? 'process' : 'processes'}`
  const why = held.every((o) => o.hold === held[0]!.hold) ? held[0]!.hold : 'still in use'
  return `${what} kept: ${why}.`
}

/**
 * What was done, in one or two sentences: "Freed about 2.1 GB: stopped 2
 * leftovers and ended 3 idle agents. 1 was left alone: still running npm in
 * the background."
 */
export function resultNote(picked: FreeUpItem[], stop: OrphanStopResult | undefined, end: EndIdleResult | undefined): string {
  const stopped = new Set((stop?.stopped ?? []).map((o) => `o:${o.pid}`))
  const ended = new Set((end?.ended ?? []).map((id) => `a:${id}`))
  const freed = picked.filter((x) => stopped.has(x.key) || ended.has(x.key)).reduce((s, x) => s + x.mem_bytes, 0)
  const done = [
    stopped.size ? `stopped ${stopped.size} ${stopped.size === 1 ? 'leftover' : 'leftovers'}` : '',
    ended.size ? `ended ${ended.size} idle ${ended.size === 1 ? 'agent' : 'agents'}` : '',
  ].filter(Boolean).join(' and ')
  const head = done ? `Freed about ${fmtMem(freed)}: ${done}.` : 'Nothing was freed.'
  const why = [
    ...(end?.skipped ?? []).map((s) => s.why),
    ...(stop?.failed ?? []).map((f) => f.error),
  ]
  const still = stop?.running?.length ?? 0
  const tail = [
    why.length ? `${why.length} ${why.length === 1 ? 'was' : 'were'} left alone: ${[...new Set(why)].map(skipWords).join('; ')}.` : '',
    still ? `${still} still running after a polite stop; Stop on its row in Caprock resources can force it.` : '',
  ].filter(Boolean).join(' ')
  return tail ? `${head} ${tail}` : head
}

/** A skip's why, as the confirmation said it. */
function skipWords(w: string): string {
  if (w === 'working') return 'it started working again'
  if (w === 'waiting') return 'it is waiting on you'
  if (w.startsWith('running in the background: ')) return `still running ${w.slice('running in the background: '.length)} in the background`
  return w
}
