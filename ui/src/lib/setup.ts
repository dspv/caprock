/**
 * The setup checklist (ADR-099): `GET /v1/setup`, this computer's readiness
 * for running agents — Git, an agent, its sign-in, a project, the link — and
 * the same read of another computer through `/v1/m/<id>/v1/setup`.
 *
 * The owner's first two-computer test (2026-11-20) got lost: the PC lacked Git
 * and Claude Code and nothing said so, and after linking the laptop showed
 * the PC without saying whether it could do anything. Each item says what to
 * do; the installs and sign-ins carry a command typed into a shell tab, never
 * run (ADR-046). An older Caprock without the route answers 404: callers
 * show nothing new then.
 */
import { createContext, useContext } from 'react'
import { ApiError } from './api'

export type SetupState = 'ok' | 'missing' | 'unknown' | 'not_needed'
export type SetupKey = 'git' | 'agent' | 'signin' | 'project' | 'link'

export interface SetupItem {
  key: SetupKey
  state: SetupState
  label: string
  detail: string
  /** Fixes it in a terminal: typed into a shell tab, never run by Caprock. */
  command?: string
}

export interface SetupReport {
  os: 'windows' | 'darwin' | 'linux' | string
  items: SetupItem[]
}

export const done = (it: SetupItem | undefined) => it?.state === 'ok' || it?.state === 'not_needed'

/** Nothing left to do. */
export function ready(r: SetupReport | undefined): boolean {
  return !!r && r.items.length > 0 && r.items.every(done)
}

/** The first item that is not done, which is the next step. */
export function nextStep(r: SetupReport | undefined): SetupItem | undefined {
  return r?.items.find((it) => !done(it))
}

export function item(r: SetupReport | undefined, key: SetupKey): SetupItem | undefined {
  return r?.items.find((it) => it.key === key)
}

/**
 * The checklist as it is shown: Git only on Windows and macOS, where it has
 * an Install button, and on Linux only while it is missing (its detail says
 * which package manager command). Everything else in the daemon's order.
 */
export function shownItems(r: SetupReport): SetupItem[] {
  return r.items.filter((it) => it.key !== 'git' || r.os === 'windows' || r.os === 'darwin' || !done(it))
}

/** `GET <base>/v1/setup`; base is '' for this computer, `machineBase(id)` for another. */
export async function fetchSetup(base = ''): Promise<SetupReport> {
  const res = await fetch(`${base}/v1/setup`, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let body: unknown
    try { body = await res.json() } catch { /* not JSON */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body)
  }
  return (await res.json()) as SetupReport
}

/** A daemon from before the checklist: say nothing new, break nothing. */
export function notThere(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501)
}

/** What the next step is, as a short phrase for "<name> needs one more step: …". */
export function stepPhrase(it: SetupItem): string {
  switch (it.key) {
    case 'git': return 'Git is not installed there'
    case 'agent': return 'no agent is installed there yet'
    case 'signin': return it.state === 'unknown' ? `${it.label.replace(/^Sign in to /, '')} may not be signed in there` : 'the agent there is not signed in'
    case 'project': return 'it has no project yet'
    case 'link': return 'its link is not finished'
  }
  return it.label
}

/**
 * The app shell's ways out of Settings (lib/setupShell.ts does the same for a
 * shell tab): New agent opened on another computer, and Add a project. In a
 * browser there is no app shell: each is absent and the caller says where to
 * do it instead.
 */
export interface AppActions {
  newAgentOn?: (machine: string) => void
  addProject?: () => void
}

export const AppActionsContext = createContext<AppActions>({})

export function useAppActions(): AppActions {
  return useContext(AppActionsContext)
}
