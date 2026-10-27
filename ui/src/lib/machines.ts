/**
 * Other computers (ADR-067): the computers this machine reaches, their
 * sessions, and the page that shows one of their sessions.
 *
 * The dashboard only ever talks to its own daemon. That daemon holds each
 * computer's channel and token, and carries a request to it through
 * `/v1/m/{id}/…` (.ai/03-contracts.md § Other computers): `/v1/m/{id}/v1/sessions`
 * is that computer's `GET /v1/sessions`, asked as this machine's paired
 * device there, with the role its owner gave it.
 *
 * - **The list** is `GET /v1/machines`, local and cheap; `?check=1` asks
 *   each computer first (Settings → Computers does, on open and on Check).
 * - **Their sessions** are one list, `GET /v1/machines/sessions` (Phase 2):
 *   the daemon reads each computer through its channel, keeps the answer a
 *   few seconds for every window, and says on `/v1/live` (`machines`) when
 *   something there changed. One channel per computer stays up while a
 *   window is open, and closes 90 s after none is (ADR-067, connected on
 *   demand).
 * - **The machine page** is this same dashboard opened at
 *   `/?machine=<id>#/session/<sid>`, in a frame of the local one. Its
 *   requests and sockets for `/v1/…` are rewritten to `/v1/m/<id>/v1/…`
 *   before they leave (installMachineProxy), as the phone's page sends them
 *   through its relay (remote/boot.ts): the Session view and its terminal
 *   are the ordinary ones, reading the other computer.
 */
import { useEffect, useMemo } from 'react'
import { ApiError, type SessionSummary } from './api'
import { useApi, type Loaded } from './useApi'
import { live } from './live'
import { needsYou } from './needs'
import { machineBase } from './machinepage'

/** One computer this machine reaches (`GET /v1/machines`). Never a token. */
export interface Machine {
  /** Its relay id: the Ed25519 key, base64url. */
  id: string
  /** This machine's label for it. */
  name: string
  relay: string
  added_at: number
  /** The channel's state, or what the computer last said about this machine:
   *  idle (no channel open), connecting, online, offline, refused, closed,
   *  pending (waiting for Allow there), revoked (removed there). */
  status: MachineStatus
  error?: string
  /** The Caprock it runs, from its last answer. */
  version?: string
  /** This machine's role there. */
  role?: 'viewer' | 'controller'
  /** `machine` when it paired this one as a computer; absent for a computer
   *  from before ADR-067's PR2, which pairs one as a phone. */
  kind?: 'machine'
  last_seen?: number
  streams: number
}

export type MachineStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'refused' | 'closed' | 'pending' | 'revoked'

export { machineBase, machinePageURL } from './machinepage'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // The daemon refuses a state-changing request without a JSON content type,
  // a DELETE with no body included.
  const write = !!init?.method && init.method !== 'GET'
  const res = await fetch(path, { ...init, headers: { Accept: 'application/json', ...(write ? { 'Content-Type': 'application/json' } : {}) } })
  if (!res.ok) {
    let body: unknown
    try { body = await res.json() } catch { /* not JSON */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body)
  }
  return (await res.json()) as T
}

/** Said on window when this page added, renamed or forgot a computer, so every list re-reads at once. */
export const MACHINES_EVENT = 'caprock:machines'

function changed<T>(p: Promise<T>): Promise<T> {
  return p.then((v) => { window.dispatchEvent(new Event(MACHINES_EVENT)); return v })
}

export const machinesApi = {
  /** `check` asks each computer first (up to 12 s), and every list on the page re-reads what it said. */
  list: (check = false) => {
    const p = call<{ machines: Machine[] }>(`/v1/machines${check ? '?check=1' : ''}`).then((r) => r.machines ?? [])
    return check ? changed(p) : p
  },
  /** Pairs with the computer a pasted link names (60 s at most). */
  add: (link: string) => changed(call<Machine>('/v1/machines', { method: 'POST', body: JSON.stringify({ link }) })),
  rename: (id: string, name: string) => changed(call<Machine>(`/v1/machines/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) })),
  /** Deletes it and its token here, after asking it to drop this machine. */
  forget: (id: string) => changed(call<{ forgotten: boolean; released: boolean }>(`/v1/machines/${encodeURIComponent(id)}`, { method: 'DELETE' })),
  /** That computer's sessions: the running ones, or every recent one. */
  /** Every computer's running sessions, kept by the daemon a few seconds, so every window shares one read per computer. */
  allSessions: () => call<{ machines: MachineSessionsEntry[] }>('/v1/machines/sessions').then((r) => r.machines ?? []),
  sessions: (id: string, activeOnly = true) =>
    call<SessionSummary[]>(`${machineBase(id)}/v1/sessions?${activeOnly ? 'active=true&' : ''}chats=exclude&limit=50`),
}

/** The computers this machine reaches, re-read every `intervalMs`. */
export function useMachines(intervalMs = 30_000): Loaded<Machine[]> {
  const got = useApi(() => machinesApi.list(), [], { live: false, intervalMs, share: 'machines' })
  const { refresh } = got
  useEffect(() => {
    window.addEventListener(MACHINES_EVENT, refresh)
    return () => window.removeEventListener(MACHINES_EVENT, refresh)
  }, [refresh])
  return got
}

/** How a computer's state reads: a word, a tone and, when there is one, what to do. */
export interface MachineLook {
  label: string
  tone: 'ok' | 'muted' | 'warn' | 'bad'
  detail?: string
  /** Its sessions can be asked for now. */
  reachable: boolean
}

export function machineLook(m: Pick<Machine, 'name' | 'status' | 'error' | 'kind' | 'role'>): MachineLook {
  switch (m.status) {
    case 'online':
      return m.kind !== 'machine' && m.role
        ? { label: 'online', tone: 'warn', reachable: true, detail: `${m.name} runs a Caprock from before computers could control each other, so this one has a phone's limits there. Update Caprock on ${m.name} for full control.` }
        : { label: 'online', tone: 'ok', reachable: true }
    case 'idle':
    case 'closed':
      return { label: 'linked', tone: 'muted', reachable: true, detail: 'Connects when you open it.' }
    case 'connecting':
      return { label: 'connecting', tone: 'muted', reachable: true }
    case 'pending':
      return { label: 'waiting for Allow', tone: 'warn', reachable: false, detail: `Allow this computer on ${m.name}: the card on its screen, or \`caprock machines allow <name>\` there.` }
    case 'revoked':
      return { label: 'removed there', tone: 'bad', reachable: false, detail: `${m.name} removed this computer. Show a new link there and add it again, or forget it here.` }
    case 'refused':
      return { label: 'refused', tone: 'bad', reachable: false, detail: `${m.name} answered with another key: it was reset, or the link is for another computer. Add it again with a new link.` }
    case 'offline':
      return { label: 'offline', tone: 'bad', reachable: true, detail: m.error ? offlineWhy(m.error) : `${m.name} is not reachable: asleep, off the internet, Caprock not running there, or its access from anywhere is off.` }
  }
  return { label: m.status, tone: 'muted', reachable: true }
}

/**
 * Why a computer is offline, said for a person: the channel's error
 * (internal/remote: "could not reach the relay: …", "the computer is
 * offline …") turned into what to check. The raw error stays in a tooltip.
 */
export function offlineWhy(err: string): string {
  if (/could not reach the relay/i.test(err)) return 'The relay could not be reached: this computer is off the internet, or the relay is down.'
  if (/computer is offline|not at the relay/i.test(err)) return 'It is not at its relay: asleep, off the internet, Caprock not running there, or its access from anywhere is off.'
  if (/closed/i.test(err)) return 'The connection was closed. It reconnects when you open it.'
  return `Not reachable (${err}): asleep, off the internet, Caprock not running there, or its access from anywhere is off.`
}
/** A computer's sessions as the sidebar and its screen read them. */
export interface MachineSessions {
  sessions: SessionSummary[]
  /** When they were last read, unix ms; 0 not yet. */
  at: number
  /** The proxy's answer when the read failed: offline, revoked, refused. */
  error?: string
  status?: string
  /** When a read last succeeded, unix ms; 0 never. */
  lastOk?: number
}

/** One computer in `GET /v1/machines/sessions` (ADR-067, Phase 2). */
export interface MachineSessionsEntry {
  id: string
  name: string
  /** online, or why its sessions are not listed: offline, pending, revoked, refused, error. */
  status: string
  error?: string
  /** Absent when the last read failed: a list from before is not what runs there now. */
  sessions?: SessionSummary[]
  at?: number
  last_ok?: number
}

/**
 * The one list across computers: `GET /v1/machines/sessions`, every
 * `intervalMs` while the window is in view, and again (debounced) when the
 * daemon says something changed on one of them — a `machines` frame on
 * `/v1/live`, sent when a prompt begins or ends there, a notification comes,
 * or a computer comes up or goes down. Every hook on the page shares one
 * request (`share`), and the daemon shares one read per computer between
 * windows, so N windows and M computers are still M reads at most every 10 s.
 */
export function useAllMachineSessions(enabled: boolean, intervalMs = 15_000): Loaded<MachineSessionsEntry[]> {
  const got = useApi(() => (enabled ? machinesApi.allSessions() : Promise.resolve([])), [enabled], { live: false, intervalMs, share: enabled ? 'machine-sessions' : false, keepUnchanged: true })
  const { refresh } = got
  useEffect(() => {
    if (!enabled) return
    let t: number | undefined
    const soon = () => { window.clearTimeout(t); t = window.setTimeout(refresh, 300) }
    const off = live.onFrame((f) => { if (f.type === 'machines') soon() })
    window.addEventListener(MACHINES_EVENT, soon)
    return () => { off(); window.clearTimeout(t); window.removeEventListener(MACHINES_EVENT, soon) }
  }, [enabled, refresh])
  return got
}

/**
 * The running sessions of each computer, by id, as the sidebar reads them.
 * A computer that answered with its state (offline, revoked) lists none.
 */
export function useMachineSessions(machines: readonly Machine[] | undefined, intervalMs = 15_000): ReadonlyMap<string, MachineSessions> {
  const got = useAllMachineSessions(!!machines && machines.length > 0, intervalMs)
  return useMemo(() => {
    const out = new Map<string, MachineSessions>()
    for (const e of got.data ?? []) {
      out.set(e.id, {
        sessions: e.sessions ?? [],
        at: e.at ?? 0,
        lastOk: e.last_ok ?? 0,
        status: e.status,
        error: e.sessions ? undefined : e.error,
      })
    }
    return out
  }, [got.data])
}

/** A session on another computer, with which computer: what the merged lists draw. */
export interface RemoteSession {
  machine: { id: string; name: string }
  session: SessionSummary
}

/** Every running session on the other computers, needing you first and oldest first among those, then newest. */
export function remoteRunning(entries: readonly MachineSessionsEntry[] | undefined): RemoteSession[] {
  const out: RemoteSession[] = []
  for (const e of entries ?? []) {
    for (const s of e.sessions ?? []) {
      if (s.status !== 'ended') out.push({ machine: { id: e.id, name: e.name }, session: s })
    }
  }
  const waits = (r: RemoteSession) => needsYou(r.session)
  return out.sort((a, b) => {
    if (waits(a) !== waits(b)) return waits(a) ? -1 : 1
    const at = a.session.last_event_at ?? 0
    const bt = b.session.last_event_at ?? 0
    return waits(a) ? at - bt : bt - at
  })
}

/** The route of a session on another computer. */
export function machineSessionRoute(machine: string, session: string): string {
  return `#/m/${machine}/session/${encodeURIComponent(session)}`
}
