/**
 * Quick chat with a choice of vendor and model (owner, 2026-10-09: "three
 * buttons to switch between model vendors — Claude, Codex, Gemini — and
 * inside, picking a model in two clicks", translated).
 *
 * Every way in opens this chooser — ⌥⌘N, the sidebar, the strip's + menu,
 * the palette: a row of the agents installed here, the selected one's models
 * under it, the last agent and model used already picked and focused, so
 * Enter alone starts it. ⌥⌘N started at once from 2026-10-09 until
 * 2026-10-12, when the owner pressed it and found himself in a terminal
 * "without being asked with whom" (translated); one keystroke to accept is
 * the price of knowing. A click on a model starts the chat on it, so another
 * vendor's model is two clicks and the last vendor's one; ← → or 1–9 (⌘1–9
 * too) switch the agent, ↑ ↓ the model, Esc closes. The choice is
 * remembered per viewer, in this browser's storage, like the New agent
 * sheet's agent.
 *
 * Since 2026-10-10 (ADR-046) the models come from the agent catalog — the
 * providers connected to OpenCode, Grok's own list, a custom agent's — and an
 * agent missing something says what and offers the fix, instead of offering
 * an empty list (owner: "OpenCode there is empty — either give buttons to
 * connect it or remove it"). Agents that are not installed are named under
 * the list, each one click from how to install it.
 *
 * A header on the started tab that restarts the chat with another model was
 * the other design: it keeps the click path instant too, but it starts a
 * process only to kill it, and a conversation already begun cannot change
 * vendor. The chooser starts exactly one.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { type CatalogEntry, type SpawnRequest } from '@/lib/api'
import { isMacPlatform } from '@/lib/appmode'
import { agentLabel, isCustomAgent, SPAWN_AGENTS, useAgentCatalog, type SpawnAgent } from './AgentPicker'
import { AgentObservedNote, AgentSetupNote } from './AgentSetup'
import { DEFAULT_MODELS, GEMINI_MODELS, listedModels, MODELS } from './SpawnDialog'
import { Sheet, SheetButton } from './Sheet'
import { SubscriptionNote, SubscriptionPicker, subscriptionsFor, useSubscriptionList } from './SubscriptionPicker'
import { InboxList } from './InboxList'
import { chosenId, hasSubscriptions, preferredId, rememberedSubscription, rememberSubscription } from '@/lib/subscriptions'

/** `subscription` is the sign-in (ADR-048): "default" is the user's own, absent the one made the default.
 *  `prompt` and `cwd` are a chat started from a saved Inbox item (lib/inbox):
 *  its first message, and its project's folder in place of a chat folder. */
export interface QuickChoice { agent: SpawnAgent; model: string; subscription?: string; prompt?: string; cwd?: string }

const KEY = 'caprock.quickchat'

function knownAgent(a: string): a is SpawnAgent {
  return SPAWN_AGENTS.some((x) => x.key === a) || isCustomAgent(a)
}

/** The vendor and model a quick chat starts on: the last one used, while the
 *  machine still has that agent; else the first agent here on its default. */
export function rememberedQuickChoice(agents: readonly SpawnAgent[]): QuickChoice {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<QuickChoice> | null
    if (v && typeof v.agent === 'string' && knownAgent(v.agent) && (agents.length === 0 || agents.includes(v.agent))) {
      return { agent: v.agent, model: typeof v.model === 'string' ? v.model : DEFAULT_MODELS[v.agent] ?? '', ...quickSubscription(v.agent) }
    }
  } catch { /* private mode, a malformed value: the default */ }
  const agent = agents.includes('claude') || agents.length === 0 ? 'claude' : agents[0]!
  return { agent, model: DEFAULT_MODELS[agent] ?? '', ...quickSubscription(agent) }
}

/** The sign-in a quick chat on `agent` was last started on, when one was picked. */
function quickSubscription(agent: string): { subscription?: string } {
  if (!hasSubscriptions(agent)) return {}
  const sub = rememberedSubscription(agent, '')
  return sub ? { subscription: sub } : {}
}

export function rememberQuickChoice(c: QuickChoice) {
  // The vendor, model and sign-in; never one chat's message or folder.
  const keep: QuickChoice = { agent: c.agent, model: c.model, ...(c.subscription ? { subscription: c.subscription } : {}) }
  try { localStorage.setItem(KEY, JSON.stringify(keep)) } catch { /* not remembering is fine */ }
}

/** What `POST /v1/agents` is sent: a chat — the daemon picks its folder — on this agent and model.
 *  From an Inbox item saved to a project, the project's folder instead, and the item as the first message. */
export function quickChatRequest(c: QuickChoice): SpawnRequest {
  const req: SpawnRequest = c.cwd ? { cwd: c.cwd } : { chat: true }
  if (c.prompt) req.prompt = c.prompt
  if (c.agent !== 'claude') req.agent = c.agent
  if (c.model) req.model = c.model
  if (c.subscription && hasSubscriptions(c.agent)) req.subscription = c.subscription
  return req
}

/** The models offered for an agent, as the New agent sheet labels them. ""
 *  is the agent's own default, for those that keep one in their config. */
export function quickModels(agent: SpawnAgent, entry?: CatalogEntry): [value: string, label: string][] {
  if (agent === 'claude') return MODELS
  if (agent === 'gemini') return GEMINI_MODELS
  return listedModels(agent, entry)
}

/** The model's short name for a tab and its hint: "Opus 5.5"; '' for the agent's own default. */
export function quickChoiceLabel(c: QuickChoice, entry?: CatalogEntry): string {
  if (!c.model) return ''
  const hit = quickModels(c.agent, entry).find(([v]) => v === c.model)
  return hit ? hit[1].split(' · ')[0]! : c.model
}

const SHORT: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode', grok: 'Grok' }

export function QuickChatSheet({
  agents,
  onStart,
  onClose,
  onSetup,
}: {
  /** The agents this machine can start, in the order offered. */
  agents: readonly SpawnAgent[]
  onStart: (c: QuickChoice) => void
  onClose: () => void
  /** Opens a shell tab in `home` with an agent's install or sign-in typed, not run. */
  onSetup?: (command: string, home?: string) => void
}) {
  const catalog = useAgentCatalog()
  const initial = useMemo(() => rememberedQuickChoice(agents), [agents])
  const [agent, setAgent] = useState<SpawnAgent>(initial.agent)
  // The highlighted model per agent: the remembered one for the remembered
  // agent, each other agent's default.
  const [models, setModels] = useState<Record<string, string>>({ ...DEFAULT_MODELS, [initial.agent]: initial.model })
  // An agent that is not installed, picked to read how to set it up.
  const [setupFor, setSetupFor] = useState<CatalogEntry | null>(null)
  useEffect(() => { setAgent(initial.agent) }, [initial.agent])
  const entry = catalog.entries.find((e) => e.id === agent)
  const options = quickModels(agent, entry)
  const current = models[agent] ?? ''
  const model = options.some(([v]) => v === current) ? current : options[0]?.[0] ?? ''
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => { list.current?.focus() }, [])
  const isMac = isMacPlatform()
  const offered = agents.map((key) => ({ key, label: agentLabel(key, catalog.entries) }))
  const missing = catalog.entries.filter((e) => !e.installed && !e.custom)
  const short = (a: SpawnAgent) => SHORT[a] ?? agentLabel(a, catalog.entries)
  const setup = onSetup && ((cmd: string) => { onSetup(cmd, catalog.home); onClose() })
  // The sign-in (ADR-048): remembered for quick chats; a pick from the
  // near-limit note holds for this chat only.
  const subscriptions = useSubscriptionList()
  const subList = subscriptionsFor(subscriptions.all, agent)
  const [subPick, setSubPick] = useState<Record<string, string>>({})
  const subWanted = subPick[agent] ?? rememberedSubscription(agent, '')
  const subId = chosenId(subList, subWanted)
  const subscription = subList.length > 1 ? subId : undefined

  const start = (m = model, a = agent) => onStart({ agent: a, model: m, ...(a === agent && subscription ? { subscription } : {}) })
  const step = (d: number) => {
    const i = offered.findIndex((a) => a.key === agent)
    const next = offered[(i + d + offered.length) % offered.length]
    if (next) { setAgent(next.key); setSetupFor(null) }
  }
  const onKey = (e: React.KeyboardEvent) => {
    const mod = isMac ? e.metaKey : e.ctrlKey
    // A digit alone picks the agent too, unless a field (the sign-in select) has the keyboard.
    const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement)
    if ((mod || bare) && /^[1-9]$/.test(e.key)) {
      const a = offered[Number(e.key) - 1]
      if (a) { setAgent(a.key); setSetupFor(null) }
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      if (!setupFor) start()
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
          <p className="mr-auto min-w-0 truncate text-[12.5px] text-fg-muted">
            <span className="mono">←→</span> agent · <span className="mono">↑↓</span> model · <span className="mono">↩</span> starts · <span className="mono">esc</span> cancels
          </p>
          <SheetButton primary disabled={agents.length === 0 || !!setupFor} onClick={() => start()} aria-keyshortcuts="Enter" title="Start (↩)" keyHint="↩">
            Start
          </SheetButton>
        </>
      }
    >
      <div className="grid gap-3 px-5 py-4" onKeyDown={onKey}>
        {agents.length === 0 && !setupFor && (
          <p className="text-[13px] text-fg-muted">No agent Caprock can start was found on this machine.</p>
        )}
        {agents.length > 0 && !setupFor && (
          <>
            <div role="radiogroup" aria-label="Agent" className="grid gap-0.5 rounded-[8px] bg-[var(--app-row-hover)] p-0.5" style={{ gridTemplateColumns: `repeat(${offered.length}, minmax(0, 1fr))` }}>
              {offered.map((a, i) => (
                <button
                  key={a.key}
                  type="button"
                  role="radio"
                  aria-checked={agent === a.key}
                  tabIndex={-1}
                  title={`${a.label}${i < 9 ? ` (${i + 1})` : ''}`}
                  onClick={() => { setAgent(a.key); list.current?.focus() }}
                  className={`h-[28px] truncate rounded-[6px] px-2 text-[12.5px] ${agent === a.key ? 'bg-panel font-medium text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}
                >
                  {short(a.key)}
                </button>
              ))}
            </div>
            <SubscriptionPicker list={subList} value={subId} onChange={(id) => { rememberSubscription(agent, '', id === preferredId(subList) ? '' : id); setSubPick((p) => ({ ...p, [agent]: id })) }} />
            <SubscriptionNote list={subList} value={subId} onUse={(id) => setSubPick((p) => ({ ...p, [agent]: id }))} />
            {entry?.setup && <AgentSetupNote entry={entry} onSetup={setup} />}
            <ul
              ref={list}
              role="listbox"
              aria-label={`${short(agent)} model`}
              tabIndex={0}
              aria-activedescendant={`qc-${agent}-${options.findIndex(([v]) => v === model)}`}
              className="app-scroll grid max-h-[260px] gap-0.5 overflow-y-auto rounded-[8px] outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
            >
              {options.map(([v, label], i) => (
                <li
                  key={v || 'default'}
                  id={`qc-${agent}-${i}`}
                  role="option"
                  aria-selected={v === model}
                  onClick={() => { setModels((cur) => ({ ...cur, [agent]: v })); start(v) }}
                  className={`flex h-[30px] shrink-0 cursor-default select-none items-center rounded-[6px] px-2.5 text-[13px] ${v === model ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'}`}
                >
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {v === model && <kbd aria-hidden="true" className="mono text-[11px] text-fg-faint">↩</kbd>}
                </li>
              ))}
            </ul>
            <AgentObservedNote entry={entry} />
          </>
        )}
        {setupFor && (
          <>
            <AgentSetupNote entry={setupFor} onSetup={setup} />
            <button type="button" onClick={() => { setSetupFor(null); list.current?.focus() }} className="w-fit text-[12px] text-fg-muted hover:text-fg">
              ← Back to the agents here
            </button>
          </>
        )}
        {missing.length > 0 && !setupFor && (
          <p className="text-[12px] leading-relaxed text-fg-faint">
            Not installed here:{' '}
            {missing.map((m, i) => (
              <span key={m.id}>
                {i > 0 && ' · '}
                <button type="button" onClick={() => setSetupFor(m)} className="text-fg-muted underline-offset-2 hover:text-fg hover:underline">{m.label}</button>
              </span>
            ))}
          </p>
        )}
      </div>
      {/* Outside the keyed area: Enter on one of its buttons presses that
        * button, not Start. Started on the agent, model and sign-in picked above. */}
      {!setupFor && agents.length > 0 && (
        <InboxList onStart={(more) => onStart({ agent, model, ...(subscription ? { subscription } : {}), ...more })} />
      )}
    </Sheet>
  )
}
