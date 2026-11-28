/**
 * Talks (ADR-110, .ai/03-contracts.md § Talks): two people's agents talk for
 * them. The API, its shapes, and what the screens say about them.
 *
 * Everything a Talk sends leaves through the daemon's guard; nothing here
 * decides what may leave. The words are the screens' only.
 */
import { getJSON, postJSON } from './api'

export type TalkState = 'invited' | 'my_turn' | 'waiting' | 'held' | 'finished' | 'ended'
export type TalkHold = '' | 'redaction' | 'needs_owner' | 'cap' | 'error'

/** One Talk on this side (GET /v1/talks). */
export interface Talk {
  id: string
  /** The other side's relay id, as Talks → People lists them. */
  person: string
  person_name: string
  goal: string
  started_by: 'me' | 'them'
  state: TalkState
  hold?: TalkHold
  ended_by?: 'me' | 'them'
  brief: string
  agent?: string
  model?: string
  max_messages: number
  max_usd: number
  /** This side's agent messages sent, and its spend in dollars as the agent reported it. */
  sent: number
  cost_usd: number
  /** The other side's total, as their Caprock reports it; absent when they do not share it. */
  their_cost_usd?: number
  /** The held message: as the agent wrote it, as it would leave, and what the guard caught. */
  draft?: string
  draft_redacted?: string
  draft_caught?: string
  draft_done?: boolean
  /** The agent's last private note to its owner: never sent. */
  note?: string
  last_error?: string
  created_at: number
  updated_at: number
}

export interface TalkAuthor {
  kind: 'agent' | 'person'
  name: string
  agent?: string
  model?: string
  edited?: boolean
}

export interface TalkEnvelope {
  v: number
  kind: 'message' | 'human' | 'state'
  talk: string
  seq: number
  prev: string
  author: TalkAuthor
  body: string
  state?: 'open' | 'ended'
  done?: boolean
  cost_usd?: number
  at: number
}

/** One envelope of a Talk, either side. */
export interface TalkEntry {
  talk: string
  side: 'me' | 'them'
  seq: number
  kind: TalkEnvelope['kind']
  hash: string
  /** How one of this side's left: by itself, from a hold, edited, typed. */
  how?: 'auto' | 'from_hold' | 'edited' | 'typed'
  caught?: string
  cost_usd?: number
  at: number
  delivered_at?: number
  envelope: TalkEnvelope
}

export interface TalkView extends Talk {
  transcript: TalkEntry[]
  /** This side's envelopes the other side has not taken yet, and why while any wait. */
  waiting: number
  offline?: string
}

/** A person linked for Talks (GET /v1/talks/people). */
export interface TalkPerson {
  id: string
  name: string
  relay: string
  added_at: number
  status: string
  error?: string
  let_start?: boolean
  safety_code: string
  last_seen?: number
  turned_on_remote?: boolean
}

export interface TalkInviteState {
  state: 'none' | 'waiting' | 'joining' | 'joined' | 'expired' | 'failed'
  expires_at?: number
  relay?: string
  relay_status?: string
  joiner?: string
  error?: string
}

export interface TalkInvite extends TalkInviteState {
  key: string
  link: string
  turned_on_remote?: boolean
}

export interface TalkSettings {
  name?: string
  brief?: string
  never_share?: string[]
  max_messages?: number
  max_usd?: number
  share_cost?: boolean
  agent?: string
  model?: string
}

export interface TalkSettingsView {
  settings: TalkSettings
  effective: { brief: string; max_messages: number; max_usd: number; share_cost: boolean }
  defaults: { brief: string; max_messages: number; max_usd: number; share_cost: boolean }
}

const t = (id: string) => `/v1/talks/${encodeURIComponent(id)}`

export const talksApi = {
  list: () => getJSON<{ talks: Talk[] }>('/v1/talks').then((r) => r.talks ?? []),
  get: (id: string) => getJSON<TalkView>(t(id)),
  start: (person: string, goal: string) => postJSON<Talk>('/v1/talks', { person, goal }),
  say: (id: string, text: string) => postJSON<Talk>(`${t(id)}/messages`, { text }),
  sendHeld: (id: string) => postJSON<Talk>(`${t(id)}/held/send`, {}),
  editHeld: (id: string, text: string) => postJSON<Talk>(`${t(id)}/held/edit`, { text }),
  dropHeld: (id: string) => postJSON<Talk>(`${t(id)}/held/drop`, {}),
  carryOn: (id: string) => postJSON<Talk>(`${t(id)}/continue`, {}),
  accept: (id: string) => postJSON<Talk>(`${t(id)}/accept`, {}),
  end: (id: string) => postJSON<Talk>(`${t(id)}/end`, {}),
  people: () => getJSON<{ people: TalkPerson[] }>('/v1/talks/people').then((r) => r.people ?? []),
  setPerson: (id: string, patch: { name?: string; let_start?: boolean }) => postJSON<{ people: TalkPerson[] }>(`/v1/talks/people/${encodeURIComponent(id)}`, patch, 'PATCH'),
  remove: (id: string) => postJSON<{ removed: boolean }>(`/v1/talks/people/${encodeURIComponent(id)}`, {}, 'DELETE'),
  invite: (name?: string) => postJSON<TalkInvite>('/v1/talks/invite', name ? { name } : {}),
  inviteState: () => getJSON<TalkInviteState>('/v1/talks/invite'),
  withdrawInvite: () => postJSON<{ withdrawn: boolean }>('/v1/talks/invite', {}, 'DELETE'),
  acceptInvite: (key: string, name?: string) => postJSON<TalkPerson>('/v1/talks/accept', name ? { key, name } : { key }),
  settings: () => getJSON<TalkSettingsView>('/v1/talks/settings'),
  saveSettings: (s: TalkSettings) => postJSON<TalkSettingsView>('/v1/talks/settings', s, 'PUT'),
}

/** The key in what was pasted: the key itself, or the whole link (what follows its last `#`). */
export function inviteKeyOf(pasted: string): string {
  const s = pasted.trim()
  const i = s.lastIndexOf('#')
  const k = (i >= 0 ? s.slice(i + 1) : s).trim()
  return k.replace(/^\/?(talks\/join\/)?/, '')
}

/** Whether a pasted text holds an invitation key. */
export function looksLikeInvite(pasted: string): boolean {
  return /^cj1-[A-Za-z0-9_-]{60,}$/.test(inviteKeyOf(pasted))
}

/** What the guard's counts say, as a person reads them: "a never-share term", "2 api keys". */
export function caughtText(caught: string | undefined): string {
  if (!caught) return ''
  return caught.split(/\s+/).filter(Boolean).map((part) => {
    const [kind, n] = part.split('=')
    const k = (kind ?? '').replace(/_/g, ' ')
    const c = Number(n) || 1
    return c === 1 ? `${/^[aeiou]/i.test(k) ? 'an' : 'a'} ${k}` : `${c} ${k}s`
  }).join(', ')
}

/** The Talk's state in a few words, from this side. */
export function stateLine(tk: Pick<Talk, 'state' | 'hold' | 'ended_by' | 'person_name'>, offline = ''): string {
  const who = tk.person_name || 'them'
  switch (tk.state) {
    case 'invited': return `${who} started this · accept to let your agent answer`
    case 'my_turn': return 'your agent is writing…'
    case 'waiting': return offline ? `${who}'s Caprock is offline · it goes when it is back` : `waiting for ${who}'s agent`
    case 'held': return tk.hold === 'cap' ? 'stopped at your cap' : tk.hold === 'error' ? 'your agent’s turn failed' : 'waiting for you'
    case 'finished': return 'both agents are done'
    case 'ended': return tk.ended_by === 'them' ? `ended by ${who}` : 'ended by you'
  }
}

/** Whether a Talk waits on this side's owner. */
export function needsMe(tk: Pick<Talk, 'state'>): boolean {
  return tk.state === 'held' || tk.state === 'invited'
}

/** Dollars as a Talk shows them: cents below $10. */
export function fmtTalkUSD(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—'
  return v < 10 ? `$${v.toFixed(2)}` : `$${v.toFixed(0)}`
}

/** Who wrote an entry, as the chat labels it: three voices — my agent, theirs, and the two people. */
export function voiceOf(e: TalkEntry, partner: string): { who: 'mine' | 'theirs' | 'me' | 'partner'; label: string } {
  const a = e.envelope.author
  if (e.side === 'me') {
    if (e.kind === 'human') return { who: 'me', label: 'You' }
    return { who: 'mine', label: `Your agent${a.model ? ` · ${a.model}` : ''}${a.edited ? ' · edited by you' : ''}` }
  }
  const name = partner || a.name || 'Partner'
  if (e.kind === 'human') return { who: 'partner', label: name }
  return { who: 'theirs', label: `${name}'s agent${a.model ? ` · ${a.model}` : ''}${a.edited ? ` · edited by ${name}` : ''}` }
}

/** How one of this side's envelopes left, for What left this machine. */
export function howText(how: TalkEntry['how']): string {
  switch (how) {
    case 'from_hold': return 'sent by you from a hold'
    case 'edited': return 'written by you in place of a held message'
    case 'typed': return 'typed by you'
    default: return 'sent by your agent'
  }
}
