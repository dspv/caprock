/**
 * New chat in three steps (ADR-091, .ai/04-ui.md § Chats): **Who works**,
 * **Where**, then the chat itself.
 *
 * - **Who** lists what can answer on this machine: Claude on the user's own
 *   sign-in, any other Claude sign-in, DeepSeek and Kimi only while their
 *   keys are set, Codex — the same availability the limit strip offers
 *   (lib/continueOn's continueChoices, ADR-090), so the two never disagree —
 *   then any other agent Caprock can start. The last pick is remembered.
 * - **Where** is a chat of its own (a new folder under the data directory's
 *   chats/, as ever) or a folder the user picked: a recent one or any other.
 *   A folder may carry a Work or Personal label (`/v1/folder-labels`),
 *   which covers the folders under it.
 */
import type { FolderLabel, FolderLabelKind, SessionSummary, SpawnRequest, SubscriptionsResponse } from './api'
import { continueChoices } from './continueOn'
import { isQuickChat } from './quickchat'
import { tildePath } from './projectSearch'
import type { SpawnAgent } from '@/components/AgentPicker'
import type { Character } from '@/components/Characters'
import type { QuickChoice } from '@/components/QuickChat'
import type { Face } from './faces'

/** One row of the Who step. */
export interface WhoOption {
  /** Stable across reads: `agent:subscription`. */
  key: string
  label: string
  /** How it is paid for, in a few words. */
  hint: string
  agent: SpawnAgent
  /** Sent as `subscription`; absent leaves the daemon's default. */
  subscription?: string
  /** DeepSeek or Kimi: Claude Code on the user's key, on that provider's model. */
  provider?: 'deepseek' | 'kimi'
  who: Character
  face?: Face
}

const OTHER: Partial<Record<string, { label: string; who: Character }>> = {
  gemini: { label: 'Gemini', who: 'gemini' },
  opencode: { label: 'OpenCode', who: 'opencode' },
  hermes: { label: 'Hermes', who: 'hermes' },
  grok: { label: 'Grok', who: 'crowd' },
}

const keyOf = (agent: string, sub?: string) => `${agent}:${sub ?? ''}`

/**
 * What the Who step offers, in its order. `agents` is what Caprock can start
 * here (the catalog); `subs` is `GET /v1/subscriptions`, undefined while it is
 * read or where it is not served — then Claude and Codex are offered plain.
 */
export function whoOptions(agents: readonly SpawnAgent[], subs: SubscriptionsResponse | undefined): WhoOption[] {
  const out: WhoOption[] = []
  const claude = agents.includes('claude')
  const codex = agents.includes('codex')
  const choices = continueChoices('', subs)
  if (claude) {
    const own = subs ? 'default' : undefined
    out.push({ key: keyOf('claude', own), label: 'Claude', hint: 'Your Claude subscription', agent: 'claude', subscription: own, who: 'lead', face: 'cap' })
    for (const c of choices) {
      if (c.summary || c.target === 'default' || c.target === 'deepseek' || c.target === 'kimi') continue
      out.push({ key: keyOf('claude', c.target), label: c.label, hint: 'Another Claude sign-in', agent: 'claude', subscription: c.target, who: c.who, face: c.face })
    }
    for (const p of ['deepseek', 'kimi'] as const) {
      const c = choices.find((x) => x.target === p)
      if (c) out.push({ key: keyOf('claude', p), label: c.label, hint: `Your ${c.label} API key`, agent: 'claude', subscription: p, provider: p, who: c.who, face: c.face })
    }
  }
  if (codex) {
    const signed = choices.filter((c) => c.summary)
    if (signed.length === 0) out.push({ key: keyOf('codex', subs ? 'default' : undefined), label: 'Codex', hint: 'ChatGPT sign-in', agent: 'codex', subscription: subs ? 'default' : undefined, who: 'codex' })
    for (const c of signed) {
      const sub = c.target === 'codex' ? 'default' : c.target
      out.push({ key: keyOf('codex', sub), label: c.label, hint: 'ChatGPT sign-in', agent: 'codex', subscription: sub, who: 'codex' })
    }
  }
  for (const a of agents) {
    if (a === 'claude' || a === 'codex') continue
    const o = OTHER[a]
    out.push({ key: keyOf(a), label: o?.label ?? a, hint: '', agent: a, who: o?.who ?? 'crowd' })
  }
  return out
}

const WHO_KEY = 'caprock.newchat.who'

/** The Who row picked last, while it is still offered. */
export function rememberedWho(options: readonly WhoOption[]): WhoOption | undefined {
  let key = ''
  try { key = localStorage.getItem(WHO_KEY) ?? '' } catch { /* private mode: nothing remembered */ }
  return options.find((o) => o.key === key)
}

export function rememberWho(o: WhoOption) {
  try { localStorage.setItem(WHO_KEY, o.key) } catch { /* not remembering is fine */ }
}

/**
 * The start choice a Who row makes. The model is the remembered one when it
 * is the same agent; a provider runs on its own model, so none is sent.
 */
export function whoChoice(o: WhoOption, current: QuickChoice): QuickChoice {
  const model = o.provider ? '' : current.agent === o.agent ? current.model : ''
  return { agent: o.agent, model, ...(o.subscription ? { subscription: o.subscription } : {}) }
}

/** What `POST /v1/agents` is sent for a chat in a folder the user picked (ADR-091), or in one of its own. */
export function folderChatRequest(c: Pick<QuickChoice, 'agent' | 'model' | 'subscription'>, cwd = ''): SpawnRequest {
  const req: SpawnRequest = { chat: true }
  if (cwd) req.cwd = cwd
  if (c.agent !== 'claude') req.agent = c.agent
  if (c.model) req.model = c.model
  if (c.subscription) req.subscription = c.subscription
  return req
}

/** The label that covers `dir`: its own, else its nearest labelled parent's. */
export function labelFor(dir: string | undefined, labels: readonly FolderLabel[] | undefined): FolderLabelKind | undefined {
  if (!dir || !labels?.length) return undefined
  const d = dir.replace(/[\\/]+$/, '')
  let best: FolderLabel | undefined
  for (const l of labels) {
    const root = l.dir.replace(/[\\/]+$/, '')
    const under = d === root || d.startsWith(`${root}/`) || d.startsWith(`${root}\\`)
    if (under && (!best || root.length > best.dir.replace(/[\\/]+$/, '').length)) best = l
  }
  return best?.label
}

/** The label set on exactly `dir`, as the row's menu shows it. */
export function ownLabel(dir: string, labels: readonly FolderLabel[] | undefined): FolderLabelKind | undefined {
  const d = dir.replace(/[\\/]+$/, '')
  return labels?.find((l) => l.dir.replace(/[\\/]+$/, '') === d)?.label
}

export const LABEL_TEXT: Record<FolderLabelKind, string> = { work: 'Work', personal: 'Personal' }

/** The Chats list's filter: every chat, or those whose folder carries the label. */
export type LabelFilter = 'all' | FolderLabelKind

export function filterByLabel<T extends Pick<SessionSummary, 'cwd'>>(items: readonly T[], f: LabelFilter, labels: readonly FolderLabel[] | undefined): T[] {
  return f === 'all' ? [...items] : items.filter((s) => labelFor(s.cwd, labels) === f)
}

/** Whether a chat runs in a folder the user picked rather than one of its own (ADR-091). */
export function inProjectFolder(s: Pick<SessionSummary, 'cwd' | 'chat'> | undefined): boolean {
  return !!s?.cwd && !isQuickChat(s)
}

/** Who gets what the agent reads: the company behind the model it runs on. */
export function providerName(s: Pick<SessionSummary, 'agent' | 'subscription'>): string {
  if (s.subscription === 'kimi') return 'Kimi'
  if (s.subscription === 'deepseek') return 'DeepSeek'
  switch ((s.agent ?? 'claude') as string) {
    case 'claude': return 'Anthropic'
    case 'codex': return 'OpenAI'
    case 'gemini': return 'Google'
    case 'grok': return 'xAI'
    default: return ''
  }
}

/**
 * The chat's context line, true to rule 4: which folder the agent works in,
 * and that what it reads goes to its model's provider and nowhere else.
 * "Sees ~/dev/acme · only Anthropic gets what it reads".
 */
export function contextLine(s: Pick<SessionSummary, 'cwd' | 'chat' | 'agent' | 'subscription'>, home?: string): string {
  const where = inProjectFolder(s) ? `Sees ${tildePath(s.cwd!, home)}` : 'Sees only its own folder'
  const who = providerName(s)
  return who ? `${where} · only ${who} gets what it reads` : where
}
