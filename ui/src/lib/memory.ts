/**
 * The machine's memory (.ai/03-contracts.md § System memory): how full it
 * is, how much the agents and Caprock hold, and the idle agents Caprock
 * started that a click can end. The totals ride on every `resources` frame
 * (lib/resources.ts, `memory`); the popover's list — each agent's state, the
 * other apps by name, what the button would end — is GET /v1/system/memory,
 * asked only while the popover is open.
 *
 * A user's Mac froze with agents holding all its memory (2026-10-22) while
 * the bar said only what the agent in front used.
 */
import { api } from './api'
import { fmtMem } from './resources'

export type MemoryLevel = 'normal' | 'tight' | 'critical'

/** The `memory` of a resources frame: totals only, which a paired phone reads too. */
export interface MachineMemory {
  /** "Mac", "Linux", "Windows", or "Memory". */
  label: string
  total: number
  used: number
  /** Absent where swap is not read (Windows). */
  swap_total?: number
  swap_used?: number
  swap_growing?: boolean
  /** The OS's own verdict; absent where it keeps none. */
  pressure?: 'normal' | 'warn' | 'critical'
  level: MemoryLevel
  agents: number
  agent_count: number
  caprock: number
  other: number
  /** The test hook faked the pressure (CAPROCK_TEST_MEMORY_PRESSURE). */
  simulated?: boolean
}

export interface MemoryAgent {
  session_id: string
  pid: number
  mem_bytes: number
  procs: number
  /** Started by Caprock: only those are ever ended. */
  owned: boolean
  state: 'working' | 'waiting' | 'idle'
  idle_since?: number
  endable: boolean
  /**
   * Why Free up memory leaves an agent Caprock started running: its state (`working`, `waiting`),
   * `the tab in front`, `idle under 15 min`, `running in the background: npm`, `the orchestrator or
   * one of its workers`. Absent when endable, for one started elsewhere, and from an older daemon.
   */
  why_not?: string
  /** Its largest process; `heavy` flags it as too big or growing for hours. */
  max_proc_bytes?: number
  heavy?: 'big' | 'growing'
  /** Started by Caprock, not mid-turn and waiting on no prompt: Restart it fresh may run now. */
  restartable?: boolean
}

export interface MemoryApp {
  name: string
  mem_bytes: number
  procs: number
  /** Runs a virtual machine (colima, Docker Desktop, QEMU): its size is the guest's memory. */
  vm?: boolean
}

/** GET /v1/system/memory. */
export interface MemoryReport {
  at: number
  memory: MachineMemory
  agents: MemoryAgent[]
  /** Absent on a paired device: totals, not what else runs on the machine. */
  apps?: MemoryApp[]
  idle_end: { count: number; mem_bytes: number; session_ids: string[] }
  error?: string
}

/** POST /v1/system/memory/restart. */
export interface RestartEnd {
  ended: boolean
  cwd?: string
  agent?: string
  why?: string
}

/** POST /v1/system/memory/end-idle. */
export interface EndIdleResult {
  ended: string[]
  skipped?: { session_id: string; why: string }[]
}

const GIB = 2 ** 30

/** "9.1/16 GB": used to a tenth, the total whole, in binary units as Activity Monitor shows them. */
export function fmtUsedOf(used: number, total: number): string {
  const t = total / GIB
  return `${(used / GIB).toFixed(1)}/${t >= 10 ? Math.round(t) : Number(t.toFixed(1))} GB`
}

/** The share of memory in use, 0–100. */
export function usedPct(m: MachineMemory): number {
  return m.total > 0 ? Math.max(0, Math.min(100, (m.used / m.total) * 100)) : 0
}

/** "Your Mac", "This computer": who the popover's header is about. */
export function machineName(m: MachineMemory): string {
  return m.label === 'Mac' ? 'Your Mac' : 'This computer'
}

/** The popover's header for each level. */
export function memoryHeadline(m: MachineMemory): string {
  const who = machineName(m)
  if (m.level === 'critical') return `${who} is out of memory`
  if (m.level === 'tight') return `${who} is running low on memory`
  return `${who}'s memory`
}

/** Why the bar is the colour it is, for its tooltip. */
export function levelReason(m: MachineMemory): string {
  const parts: string[] = []
  if (m.pressure === 'critical') parts.push('the system reports critical memory pressure')
  else if (m.pressure === 'warn') parts.push('the system reports memory pressure')
  if (m.swap_growing) parts.push('it is moving memory to disk (swap) as it goes')
  if (m.level !== 'normal' && parts.length === 0) parts.push('85% or more of memory is in use')
  return parts.join(', and ')
}

/** "idle 12 min", "idle 3 h", "working", "waiting on you". */
export function agentStateText(a: MemoryAgent, now: number): string {
  if (a.state === 'working') return 'working'
  if (a.state === 'waiting') return 'waiting on you'
  if (!a.idle_since) return 'idle'
  const min = Math.max(1, Math.round((now - a.idle_since) / 60_000))
  if (min < 60) return `idle ${min} min`
  const h = Math.round(min / 60)
  return h < 48 ? `idle ${h} h` : `idle ${Math.round(h / 24)} d`
}

/**
 * Whether the parts come to more than is in use. `used` is RAM, with
 * compressed memory at its compressed size and swapped-out memory not in it;
 * each part is its processes' footprints, as Activity Monitor's Memory
 * column shows them, which count compressed and swapped-out pages at full
 * size. On a Mac that swaps — an idle virtual machine's guest is mostly in
 * swap — the parts add up past `used`.
 */
export function partsBeyondUsed(m: MachineMemory): boolean {
  return m.agents + m.caprock + m.other > m.used
}

/** The note under the parts when they add up past what is in use. */
export function beyondUsedNote(m: MachineMemory): string {
  return `Sizes are what each holds, as Activity Monitor shows them: they count memory compressed or moved to swap, so together they come to more than the ${fmtMem(m.used)} in use.`
}

/** What a virtual machine's size means, for its row's tooltip. */
export const VM_NOTE = "A virtual machine's size is all the memory its guest has used, including what was compressed or moved to swap; it holds less than that in RAM."

/**
 * The stacked bar's parts, as shares of the total: agents, Caprock, other
 * apps, free. Where the parts come to more than is in use
 * (partsBeyondUsed), they split the used share between them, so the bar
 * never shows more in use than there is.
 */
export function memoryParts(m: MachineMemory): { key: 'agents' | 'caprock' | 'other'; label: string; bytes: number; pct: number }[] {
  const sum = m.agents + m.caprock + m.other
  const scale = sum > m.used && sum > 0 ? m.used / sum : 1
  const pct = (b: number) => (m.total > 0 ? Math.max(0, (b * scale / m.total) * 100) : 0)
  return [
    { key: 'agents', label: m.agent_count === 1 ? '1 agent' : `${m.agent_count} agents`, bytes: m.agents, pct: pct(m.agents) },
    { key: 'caprock', label: 'Caprock', bytes: m.caprock, pct: pct(m.caprock) },
    { key: 'other', label: 'Other apps and the system', bytes: m.other, pct: pct(m.other) },
  ]
}

const CLI: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI', deepseek: 'DeepSeek Harness', hermes: 'Hermes Agent' }

/** What the heavy flag says: "3.1 GB in one process" or "growing for hours · 2.4 GB". */
export function heavyText(heavy: 'big' | 'growing', maxProc: number | undefined): string {
  return heavy === 'big' ? `${fmtMem(maxProc)} in one process` : `growing for hours · ${fmtMem(maxProc)}`
}

/** The one line under the flag: why, and what restarting does. */
export function heavyLine(agent?: string): string {
  const cli = (agent && CLI[agent]) || 'agent'
  return `Long ${cli} sessions grow in memory; restarting frees it without losing the conversation.`
}

/**
 * Restart it fresh: the daemon ends the agent the way End does and answers
 * once it has exited; then the conversation is continued in a new process,
 * as Continue does. Returns the session the conversation now runs in.
 */
export async function restartFresh(sessionId: string, cwd?: string): Promise<string> {
  const r = await api.restartEnd(sessionId)
  if (!r.ended) throw new Error(r.why === 'working' ? 'It is working; restart it once its turn ends.' : `Not restarted: ${r.why ?? 'unknown'}.`)
  const res = await api.spawn({ cwd: r.cwd || cwd || '', resume: sessionId, fork: false })
  return res.session_id
}
