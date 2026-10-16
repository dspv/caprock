import { useEffect, useMemo, useState } from 'react'
import { api, type CatalogEntry, type Status } from '@/lib/api'
import { useApi } from '@/lib/useApi'

/**
 * Which coding agent a new session runs.
 *
 * One component, because more than one place starts a session — the New
 * session dialog, and a project row's "New session here" — and a second copy
 * of this list is how one of them ends up offering an agent the other does
 * not, or remembering a choice the other ignores.
 *
 * Since 2026-10-10 (ADR-046) the list comes from `GET /v1/agents/catalog`:
 * every agent Caprock knows, installed or not, with its models and what is
 * missing, plus the user's custom agents. An agent that is not installed is
 * never the default choice, but it is listed, so the way to set it up is one
 * pick away rather than nowhere.
 */

/** The agents Caprock knows by name. */
export type BuiltinAgent = 'claude' | 'codex' | 'opencode' | 'gemini' | 'grok' | 'hermes'
/** A built-in agent, or one the user added in Settings → Agents. */
export type SpawnAgent = BuiltinAgent | `custom:${string}`

export const SPAWN_AGENTS: { key: BuiltinAgent; label: string }[] = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
  { key: 'opencode', label: 'OpenCode' },
  // No billing note here: Gemini CLI signs in with Google as well as with a
  // key, so "your own key" told most people something untrue.
  { key: 'gemini', label: 'Gemini CLI' },
  { key: 'grok', label: 'Grok' },
  { key: 'hermes', label: 'Hermes' },
]

export function isCustomAgent(a: string): a is `custom:${string}` {
  return a.startsWith('custom:')
}

/** The agents this machine can start, from the daemon's status. An agent is
 *  offered only when its binary was found: a choice that fails on click is
 *  worse than no choice. */
export function spawnableAgents(s?: Partial<Status>): SpawnAgent[] {
  if (!s) return []
  const has: Record<BuiltinAgent, boolean | undefined> = {
    claude: s.claude_available,
    codex: s.codex_available,
    opencode: s.opencode_available,
    gemini: s.gemini_available,
    grok: s.grok_available,
    hermes: s.hermes_available,
  }
  return SPAWN_AGENTS.map((a) => a.key).filter((k) => has[k])
}

/** The catalog an older daemon cannot give, made from its status: installed
 *  or not, and nothing else known. */
export function entriesFromStatus(s?: Partial<Status>): CatalogEntry[] {
  const have = spawnableAgents(s)
  return SPAWN_AGENTS.map((a) => ({
    id: a.key, label: a.label, installed: have.includes(a.key), ready: have.includes(a.key),
    models: [], observed: a.key !== 'grok', prompt: true,
  }))
}

/** The agents a session can start on: installed, and not locked. */
export function startable(entries: readonly CatalogEntry[]): SpawnAgent[] {
  return entries.filter((e) => e.installed && !e.locked).map((e) => e.id as SpawnAgent)
}

/** The daemon's catalog, fetched once; the status stands in on a daemon
 *  that predates it. */
export function useAgentCatalog(): { entries: CatalogEntry[]; loaded: boolean; home?: string; licensed: boolean; refresh: () => void } {
  const catalog = useApi(() => api.agentCatalog(), [], { live: false })
  const status = useApi(() => (catalog.error ? api.status() : Promise.resolve(undefined)), [!!catalog.error], { live: false })
  const entries = useMemo(
    () => catalog.data?.agents ?? (catalog.error ? entriesFromStatus(status.data) : []),
    [catalog.data, catalog.error, status.data],
  )
  return {
    entries,
    loaded: !!catalog.data || (!!catalog.error && (!!status.data || !!status.error)),
    home: catalog.data?.home,
    licensed: !!catalog.data?.licensed,
    refresh: () => catalog.refresh?.(),
  }
}

/** The daemon's answer, fetched once. A caller that already has the status
 *  passes it instead. */
export function useSpawnableAgents(known?: Partial<Status>): SpawnAgent[] {
  const { entries } = useAgentCatalog()
  const fromCatalog = startable(entries)
  const fromKnown = spawnableAgents(known)
  return useMemo(() => [...fromCatalog, ...fromKnown.filter((k) => !fromCatalog.includes(k))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fromCatalog.join(','), fromKnown.join(',')])
}

/** What an agent is called, custom ones by the name the user gave. */
export function agentLabel(id: string, entries?: readonly CatalogEntry[]): string {
  return entries?.find((e) => e.id === id)?.label ?? SPAWN_AGENTS.find((a) => a.key === id)?.label ?? id.replace(/^custom:/, '')
}

// Per viewer and per browser. The picker starts on the default agent, not on
// the last one used (owner, 2026-10-11, translated: "why is Codex the default?
// I want to choose, or Claude first"): one Codex session must not turn every
// later New agent into Codex. The default is Claude Code until the viewer
// makes another one the default, in the picker itself.
const DEFAULT_KEY = 'caprock.spawn.defaultAgent'

export function defaultAgent(): SpawnAgent {
  try {
    const v = localStorage.getItem(DEFAULT_KEY)
    if (v && (SPAWN_AGENTS.some((a) => a.key === v) || isCustomAgent(v))) return v as SpawnAgent
  } catch {
    // private mode, blocked storage: Claude Code, no failure
  }
  return 'claude'
}

export function setDefaultAgent(a: SpawnAgent) {
  try {
    localStorage.setItem(DEFAULT_KEY, a)
  } catch {
    // Not remembering is fine; failing to start a session over it is not.
  }
}

/**
 * The agent a picker starts on: the default, if the machine has it, otherwise
 * the first one it has. Follows `agents` as it loads — the status arrives after
 * the first render — until the viewer picks one. The third element makes the
 * current choice the default.
 */
export function useAgentChoice(agents: SpawnAgent[]): [SpawnAgent, (a: SpawnAgent) => void, { isDefault: boolean; makeDefault: () => void }] {
  const pick = (): SpawnAgent => {
    const d = defaultAgent()
    if (agents.includes(d)) return d
    return agents[0] ?? 'claude'
  }
  const [agent, setAgent] = useState<SpawnAgent>(pick)
  const [touched, setTouched] = useState(false)
  const [def, setDef] = useState<SpawnAgent>(defaultAgent)
  const key = agents.join(',')
  useEffect(() => {
    if (!touched) setAgent(pick())
    // pick reads only `agents`, which `key` stands for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, touched])
  const choose = (a: SpawnAgent) => {
    setTouched(true)
    setAgent(a)
  }
  const makeDefault = () => {
    setDefaultAgent(agent)
    setDef(agent)
  }
  return [agent, choose, { isDefault: def === agent, makeDefault }]
}

/** The control itself. Renders nothing when there is only one agent to pick
 *  and nothing to set up: a select with one option is a question with no
 *  choice in it. With `entries`, the agents that are not installed are listed
 *  after the rest, marked, so picking one shows how to set it up. */
export function AgentPicker({
  value,
  agents,
  entries,
  onChange,
  className = 'input',
  dflt,
}: {
  value: SpawnAgent
  agents: SpawnAgent[]
  entries?: readonly CatalogEntry[]
  onChange: (a: SpawnAgent) => void
  className?: string
  /** Shows "default" beside the label, or a *Make default* link when the choice is another agent. */
  dflt?: { isDefault: boolean; makeDefault: () => void }
}) {
  const options: { key: string; label: string }[] = entries
    ? [
        ...entries.filter((e) => agents.includes(e.id as SpawnAgent)).map((e) => ({ key: e.id, label: e.label })),
        ...entries.filter((e) => !agents.includes(e.id as SpawnAgent)).map((e) => ({ key: e.id, label: `${e.label} · ${e.locked ? 'Premium' : 'not installed'}` })),
      ]
    : SPAWN_AGENTS.filter((a) => agents.includes(a.key))
  if (options.length < 2) return null
  return (
    <label className="grid min-w-0 gap-1">
      <span className="flex items-baseline gap-2 text-[13px] font-medium text-fg-muted">
        Agent
        {dflt && agents.includes(value) && (dflt.isDefault ? (
          <span className="font-normal text-fg-faint">default</span>
        ) : (
          <button type="button" onClick={(e) => { e.preventDefault(); dflt.makeDefault() }} className="font-normal text-accent hover:underline">
            Make default
          </button>
        ))}
      </span>
      <select aria-label="Agent" className={className} value={value} onChange={(e) => onChange(e.target.value as SpawnAgent)}>
        {options.map((a) => (
          <option key={a.key} value={a.key}>
            {a.label}
          </option>
        ))}
      </select>
    </label>
  )
}
