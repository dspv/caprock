/**
 * Starting a chat in one tap (ADR-071; owner, 2026-10-16, translated: "one
 * button and a chat starts at once; at most a model choice — by default you
 * just click and get a new chat").
 *
 * - **useChatChoice** is the agent and model a new chat starts on: the last
 *   one picked, kept in this browser like the Quick chat chooser's (they
 *   share it, components/QuickChat), else Claude on its default model.
 * - **ModelChip** says that choice ("Claude · Opus 5.5") and opens
 *   **ModelSheet**, which picks the vendor and the model; the pick is
 *   remembered and starts nothing. The chat starts from its own button.
 * - **ChatSheet** is the sheet both use: a bottom sheet at phone width, a
 *   centred dialog otherwise.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isPairedDevice } from '@/lib/api'
import { useNarrowScreen } from '@/lib/phone'
import { agentLabel, isCustomAgent, startable, useAgentCatalog, type SpawnAgent } from './AgentPicker'
import { quickChoiceLabel, quickModels, rememberedQuickChoice, rememberQuickChoice, type QuickChoice } from './QuickChat'
import { AgentGlyph } from './AgentMarks'
import { ChevronIcon, CloseIcon } from './AppIcons'

const SHORT: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode', grok: 'Grok', hermes: 'Hermes' }

/** The agents a chat may start on here; on a phone, only those Caprock knows by name. */
function useChatAgents() {
  const catalog = useAgentCatalog()
  const paired = isPairedDevice()
  const agents = startable(catalog.entries).filter((a) => !(paired && isCustomAgent(a)))
  return { agents, entries: catalog.entries, loaded: catalog.loaded }
}

/** The vendor and model the next chat starts on, and a way to change it. */
export function useChatChoice() {
  const { agents, entries, loaded } = useChatAgents()
  const key = agents.join(',')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => rememberedQuickChoice(agents), [key])
  const [picked, setPicked] = useState<QuickChoice | null>(null)
  const choice = picked && (agents.length === 0 || agents.includes(picked.agent)) ? picked : initial
  const entry = entries.find((e) => e.id === choice.agent)
  const pick = (c: QuickChoice) => { rememberQuickChoice(c); setPicked(c) }
  return { choice, pick, agents, entries, loaded, label: choiceLabel(choice, agentLabel(choice.agent, entries), quickChoiceLabel(choice, entry)) }
}

function choiceLabel(c: QuickChoice, agent: string, model: string): string {
  const a = SHORT[c.agent] ?? agent
  return model ? `${a} · ${model}` : a
}

/** "Claude · Opus 5.5 ▾": the choice, one tap from changing it. */
export function ModelChip({ chat, big = false }: { chat: ReturnType<typeof useChatChoice>; big?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label={`Model: ${chat.label}. Change`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={`inline-flex min-w-0 shrink items-center gap-1.5 rounded-full border border-border-strong bg-bg text-fg-muted hover:text-fg ${big ? 'min-h-11 px-3.5 text-[15px]' : 'h-8 px-3 text-[13px]'}`}
      >
        <AgentGlyph agent={chat.choice.agent} size={big ? 14 : 12} />
        <span className="truncate">{chat.label}</span>
        <span className="rotate-90 text-fg-faint"><ChevronIcon size={12} /></span>
      </button>
      {open && <ModelSheet chat={chat} onClose={() => setOpen(false)} />}
    </>
  )
}

/** The vendor and model, picked in two taps at most and remembered. */
export function ModelSheet({ chat, onClose }: { chat: ReturnType<typeof useChatChoice>; onClose: () => void }) {
  const [agent, setAgent] = useState<SpawnAgent>(chat.choice.agent)
  const entry = chat.entries.find((e) => e.id === agent)
  const options = quickModels(agent, entry)
  const current = agent === chat.choice.agent ? chat.choice.model : options[0]?.[0] ?? ''
  return (
    <ChatSheet title="Model for new chats" onClose={onClose}>
      {chat.agents.length === 0 ? (
        <p className="text-[14px] text-fg-muted">{chat.loaded ? 'No agent Caprock can start was found on this machine.' : 'Reading the agents…'}</p>
      ) : (
        <div className="grid gap-3">
          <div role="radiogroup" aria-label="Vendor" className="flex flex-wrap gap-1.5">
            {chat.agents.map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={a === agent}
                onClick={() => setAgent(a)}
                className={`inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 text-[14px] ${a === agent ? 'border-accent bg-accent/15 font-medium text-accent' : 'border-border-strong bg-bg text-fg'}`}
              >
                <AgentGlyph agent={a} size={12} /> {SHORT[a] ?? agentLabel(a, chat.entries)}
              </button>
            ))}
          </div>
          <ul role="listbox" aria-label={`${SHORT[agent] ?? agent} model`} className="overflow-hidden rounded-[12px] border border-border bg-bg">
            {options.length === 0 && <li className="px-3 py-3 text-[14px] text-fg-muted">Its own default model</li>}
            {options.map(([v, label]) => {
              const on = v === current && agent === chat.choice.agent
              const [name, ...rest] = label.split(' · ')
              return (
                <li key={v || 'default'} role="option" aria-selected={on} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => { chat.pick({ agent, model: v }); onClose() }}
                    className={`flex min-h-[50px] w-full items-center gap-3 px-3 text-left ${on ? 'bg-accent/10' : ''}`}
                  >
                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${on ? 'border-accent' : 'border-border-strong'}`}>
                      {on && <span className="h-2.5 w-2.5 rounded-full bg-accent" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-fg">{name}</span>
                      {rest.length > 0 && <span className="block truncate text-[12.5px] text-fg-faint">{rest.join(' · ')}</span>}
                    </span>
                  </button>
                </li>
              )
            })}
            {options.length === 0 && (
              <li><button type="button" onClick={() => { chat.pick({ agent, model: '' }); onClose() }} className="min-h-11 w-full text-[14px] text-accent">Use {SHORT[agent] ?? agent}</button></li>
            )}
          </ul>
        </div>
      )}
    </ChatSheet>
  )
}

/** A sheet: from the bottom on a phone, a centred dialog elsewhere. Esc and the backdrop close it. */
export function ChatSheet({ title, onClose, children, footer, wide = false }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const phone = useNarrowScreen()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className={`fixed inset-0 z-50 flex bg-black/45 ${phone ? 'items-end' : 'items-center justify-center p-6'}`} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex flex-col border-border-strong bg-panel text-fg shadow-[0_-24px_64px_-20px_rgba(0,0,0,0.55)] ${phone ? 'max-h-[94dvh] w-full rounded-t-[18px] border-t' : `max-h-[86vh] w-full rounded-[14px] border ${wide ? 'max-w-[760px]' : 'max-w-[440px]'}`}`}
      >
        {phone && <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border-strong" />}
        <div className="flex items-center px-4 pb-1 pt-2">
          <h2 className="min-w-0 truncate text-[18px] font-semibold">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="ml-auto grid h-10 w-10 shrink-0 place-items-center rounded-full text-fg-muted hover:text-fg"><CloseIcon size={20} /></button>
        </div>
        <div className="min-h-0 overflow-y-auto px-4 pb-4">{children}</div>
        {footer && <div className="border-t border-border px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
