/**
 * Quick chat with a choice of vendor and model (owner, 2026-10-09: "three
 * buttons to switch between model vendors — Claude, Codex, Gemini — and
 * inside, picking a model in two clicks", translated).
 *
 * The decision that keeps it instant: **⌥⌘N never asks.** It starts at once
 * on the vendor and model used last (or Claude Code on its default). Clicking
 * *Quick chat* — the sidebar, the strip's + menu, the palette's *Quick chat
 * with…* — opens this chooser instead: a row of the agents installed here,
 * the selected one's models under it. A click on a model starts the chat on
 * it, so another vendor's model is two clicks from the chooser and the last
 * vendor's is one; Enter (or ⌘↩) starts on the highlighted model, so the
 * chooser costs one key over the shortcut. ← → or ⌘1–4 switch the agent,
 * ↑ ↓ the model, Esc closes. The choice is remembered per viewer, in this
 * browser's storage, like the New agent sheet's agent.
 *
 * A header on the started tab that restarts the chat with another model was
 * the other design: it keeps the click path instant too, but it starts a
 * process only to kill it, and a conversation already begun cannot change
 * vendor. The chooser starts exactly one.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type SpawnRequest } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { isMacPlatform } from '@/lib/appmode'
import { SPAWN_AGENTS, type SpawnAgent } from './AgentPicker'
import { DEFAULT_MODELS, GEMINI_MODELS, MODELS } from './SpawnDialog'
import { Sheet, SheetButton } from './Sheet'

export interface QuickChoice { agent: SpawnAgent; model: string }

const KEY = 'caprock.quickchat'

/** The vendor and model a quick chat starts on: the last one used, while the
 *  machine still has that agent; else the first agent here on its default. */
export function rememberedQuickChoice(agents: readonly SpawnAgent[]): QuickChoice {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<QuickChoice> | null
    if (v && typeof v.agent === 'string' && SPAWN_AGENTS.some((a) => a.key === v.agent) && (agents.length === 0 || agents.includes(v.agent as SpawnAgent))) {
      return { agent: v.agent as SpawnAgent, model: typeof v.model === 'string' ? v.model : DEFAULT_MODELS[v.agent as SpawnAgent] }
    }
  } catch { /* private mode, a malformed value: the default */ }
  const agent = agents.includes('claude') || agents.length === 0 ? 'claude' : agents[0]!
  return { agent, model: DEFAULT_MODELS[agent] }
}

export function rememberQuickChoice(c: QuickChoice) {
  try { localStorage.setItem(KEY, JSON.stringify(c)) } catch { /* not remembering is fine */ }
}

/** What `POST /v1/agents` is sent: a chat — the daemon picks its folder — on this agent and model. */
export function quickChatRequest(c: QuickChoice): SpawnRequest {
  const req: SpawnRequest = { chat: true }
  if (c.agent !== 'claude') req.agent = c.agent
  if (c.model) req.model = c.model
  return req
}

/** The models offered for an agent, as the New agent sheet labels them. "" is
 *  the agent's own default, for the two that keep one in their config. */
export function quickModels(agent: SpawnAgent, codex?: { default?: string; models: { id: string; label: string }[] }): [value: string, label: string][] {
  if (agent === 'claude') return MODELS
  if (agent === 'gemini') return GEMINI_MODELS
  if (agent === 'codex') {
    return [['', codex?.default ? `${codex.default} (default)` : 'Codex default'], ...(codex?.models ?? []).filter((m) => m.id !== codex?.default).map((m): [string, string] => [m.id, m.label])]
  }
  return [['', 'OpenCode default']]
}

const SHORT: Record<SpawnAgent, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode' }

export function QuickChatSheet({
  agents,
  onStart,
  onClose,
}: {
  /** The agents this machine can start, in the order offered. */
  agents: readonly SpawnAgent[]
  onStart: (c: QuickChoice) => void
  onClose: () => void
}) {
  const initial = useMemo(() => rememberedQuickChoice(agents), [agents])
  const [agent, setAgent] = useState<SpawnAgent>(initial.agent)
  // The highlighted model per agent: the remembered one for the remembered
  // agent, each other agent's default.
  const [models, setModels] = useState<Record<SpawnAgent, string>>({ ...DEFAULT_MODELS, [initial.agent]: initial.model })
  useEffect(() => { setAgent(initial.agent) }, [initial.agent])
  const codex = useApi(() => (agents.includes('codex') ? api.agentModels('codex') : Promise.resolve(undefined)), [agents.includes('codex')], { live: false })
  const options = quickModels(agent, codex.data)
  const model = options.some(([v]) => v === models[agent]) ? models[agent] : options[0]?.[0] ?? ''
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => { list.current?.focus() }, [])
  const isMac = isMacPlatform()
  const offered = SPAWN_AGENTS.filter((a) => agents.includes(a.key))

  const start = (m = model, a = agent) => onStart({ agent: a, model: m })
  const step = (d: number) => {
    const i = offered.findIndex((a) => a.key === agent)
    const next = offered[(i + d + offered.length) % offered.length]
    if (next) setAgent(next.key)
  }
  const onKey = (e: React.KeyboardEvent) => {
    const mod = isMac ? e.metaKey : e.ctrlKey
    if (mod && /^[1-4]$/.test(e.key)) {
      const a = offered[Number(e.key) - 1]
      if (a) setAgent(a.key)
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      start()
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      step(e.key === 'ArrowLeft' ? -1 : 1)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const i = options.findIndex(([v]) => v === model)
      const next = options[Math.max(0, Math.min(options.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) setModels((cur) => ({ ...cur, [agent]: next[0] }))
    } else {
      return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <Sheet
      label="Quick chat"
      title="Quick chat"
      width={440}
      onClose={onClose}
      footer={
        <>
          <p className="mr-auto min-w-0 truncate text-[11.5px] text-fg-faint">
            <span className="mono">←→</span> agent · <span className="mono">↑↓</span> model · <span className="mono">{isMac ? '⌥⌘N' : 'Ctrl+Alt+Shift+N'}</span> skips this
          </p>
          <SheetButton primary disabled={agents.length === 0} onClick={() => start()} aria-keyshortcuts="Enter" title="Start (↩)">
            Start
            <kbd aria-hidden="true" className="mono ml-2 text-[11px] font-normal opacity-70">↩</kbd>
          </SheetButton>
        </>
      }
    >
      <div className="grid gap-3 px-5 py-4" onKeyDown={onKey}>
        {agents.length === 0 ? (
          <p className="text-[13px] text-fg-muted">No agent Caprock can start was found on this machine.</p>
        ) : (
          <>
            <div role="radiogroup" aria-label="Agent" className="grid gap-0.5 rounded-[8px] bg-[var(--app-row-hover)] p-0.5" style={{ gridTemplateColumns: `repeat(${offered.length}, minmax(0, 1fr))` }}>
              {offered.map((a, i) => (
                <button
                  key={a.key}
                  type="button"
                  role="radio"
                  aria-checked={agent === a.key}
                  tabIndex={-1}
                  title={`${a.label} (${isMac ? '⌘' : 'Ctrl+'}${i + 1})`}
                  onClick={() => { setAgent(a.key); list.current?.focus() }}
                  className={`h-[28px] truncate rounded-[6px] px-2 text-[12.5px] ${agent === a.key ? 'bg-panel font-medium text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}
                >
                  {SHORT[a.key]}
                </button>
              ))}
            </div>
            <ul
              ref={list}
              role="listbox"
              aria-label={`${SHORT[agent]} model`}
              tabIndex={0}
              aria-activedescendant={`qc-${agent}-${options.findIndex(([v]) => v === model)}`}
              className="grid gap-0.5 rounded-[8px] outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
            >
              {options.map(([v, label], i) => (
                <li
                  key={v || 'default'}
                  id={`qc-${agent}-${i}`}
                  role="option"
                  aria-selected={v === model}
                  onClick={() => { setModels((cur) => ({ ...cur, [agent]: v })); start(v) }}
                  className={`flex h-[30px] cursor-default select-none items-center rounded-[6px] px-2.5 text-[13px] ${v === model ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'}`}
                >
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {v === model && <kbd aria-hidden="true" className="mono text-[11px] text-fg-faint">↩</kbd>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Sheet>
  )
}
