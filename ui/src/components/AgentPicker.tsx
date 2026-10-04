import { useEffect, useState } from 'react'
import { api, type Status } from '@/lib/api'
import { useApi } from '@/lib/useApi'

/**
 * Which coding agent a new session runs.
 *
 * One component, because more than one place starts a session — the New
 * session dialog, and a project row's "New session here" — and a second copy
 * of this list is how one of them ends up offering an agent the other does
 * not, or remembering a choice the other ignores.
 */

/** The agents Caprock can start, in the order the picker offers them. */
export type SpawnAgent = 'claude' | 'codex' | 'opencode' | 'gemini'

export const SPAWN_AGENTS: { key: SpawnAgent; label: string }[] = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
  { key: 'opencode', label: 'OpenCode' },
  // Gemini runs on the user's own key, which is worth saying at the moment of
  // choosing it rather than when it asks for one.
  { key: 'gemini', label: 'Gemini CLI · your own key' },
]

/** The agents this machine can start, from the daemon's status. An agent is
 *  offered only when its binary was found: a choice that fails on click is
 *  worse than no choice. */
export function spawnableAgents(s?: Partial<Status>): SpawnAgent[] {
  if (!s) return []
  const has: Record<SpawnAgent, boolean | undefined> = {
    claude: s.claude_available,
    codex: s.codex_available,
    opencode: s.opencode_available,
    gemini: s.gemini_available,
  }
  return SPAWN_AGENTS.map((a) => a.key).filter((k) => has[k])
}

/** The daemon's answer, fetched once. A caller that already has the status
 *  passes it instead. */
export function useSpawnableAgents(known?: Partial<Status>): SpawnAgent[] {
  const status = useApi(() => api.status(), [], { live: false })
  const fromStatus = spawnableAgents(status.data)
  const fromKnown = spawnableAgents(known)
  return SPAWN_AGENTS.map((a) => a.key).filter((k) => fromStatus.includes(k) || fromKnown.includes(k))
}

// Per viewer and per browser: which agent someone reaches for is a habit of
// the person at this keyboard, not a setting of the machine.
const KEY = 'caprock.spawn.agent'

export function rememberedAgent(): SpawnAgent | undefined {
  try {
    const v = localStorage.getItem(KEY)
    return SPAWN_AGENTS.some((a) => a.key === v) ? (v as SpawnAgent) : undefined
  } catch {
    return undefined // private mode, blocked storage: no memory, no failure
  }
}

export function rememberAgent(a: SpawnAgent) {
  try {
    localStorage.setItem(KEY, a)
  } catch {
    // Not remembering is fine; failing to start a session over it is not.
  }
}

/**
 * The agent a picker starts on: the one this viewer chose last, if the machine
 * still has it, otherwise the first one it has. Follows `agents` as it loads —
 * the status arrives after the first render — until the viewer picks one.
 */
export function useAgentChoice(agents: SpawnAgent[]): [SpawnAgent, (a: SpawnAgent) => void] {
  const pick = (): SpawnAgent => {
    const last = rememberedAgent()
    if (last && agents.includes(last)) return last
    return agents[0] ?? 'claude'
  }
  const [agent, setAgent] = useState<SpawnAgent>(pick)
  const [touched, setTouched] = useState(false)
  const key = agents.join(',')
  useEffect(() => {
    if (!touched) setAgent(pick())
    // pick reads only `agents`, which `key` stands for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, touched])
  const choose = (a: SpawnAgent) => {
    setTouched(true)
    setAgent(a)
    rememberAgent(a)
  }
  return [agent, choose]
}

/** The control itself. Renders nothing when there is only one agent to pick:
 *  a select with one option is a question with no choice in it. */
export function AgentPicker({
  value,
  agents,
  onChange,
  className = 'input',
}: {
  value: SpawnAgent
  agents: SpawnAgent[]
  onChange: (a: SpawnAgent) => void
  className?: string
}) {
  if (agents.length < 2) return null
  return (
    <label className="grid min-w-0 gap-1">
      <span className="text-[11px] text-fg-muted">Agent</span>
      <select className={className} value={value} onChange={(e) => onChange(e.target.value as SpawnAgent)}>
        {SPAWN_AGENTS.filter((a) => agents.includes(a.key)).map((a) => (
          <option key={a.key} value={a.key}>
            {a.label}
          </option>
        ))}
      </select>
    </label>
  )
}
