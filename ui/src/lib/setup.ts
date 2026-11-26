/**
 * The setup checklist (ADR-099): `GET /v1/setup`, this computer's readiness
 * for running agents — Git, the agents switched on (each installed and
 * signed in), the link, and projects here (optional) — and
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
  /** What the command does when it is not an install: `path` adds the agent's folder to the user's PATH. */
  action?: 'path' | string
  /** Never a step left (the project): `ok` or `not_needed`, drawn with a dashed circle. */
  optional?: boolean
}

/** One agent under the Agents item, with its switch (ADR-099 amendment, 2026-11-20). */
export interface SetupAgent {
  id: string
  label: string
  /** Switched on: set up here and counted. Off: grey, `not_needed`. */
  on: boolean
  state: SetupState
  detail: string
  /** The one step left: install, put on the PATH, sign in. */
  step?: 'install' | 'path' | 'signin' | string
  command?: string
  action?: 'path' | string
}

export interface SetupReport {
  os: 'windows' | 'darwin' | 'linux' | string
  items: SetupItem[]
  /** The Agents item's rows; absent from a daemon before the switches. */
  agents?: SetupAgent[]
  /**
   * Steps past ready that a linked laptop runs there (issue #1088): Node.js,
   * the GitHub CLI and its sign-in, Claude Code's bypass warning and Claude
   * in Chrome's "Enabled by default". Never counted by `ready`; absent from
   * a daemon before them (lib/remotesetup.ts).
   */
  tools?: SetupTool[]
}

/** One of the report's tools (internal/readiness/tools.go). */
export interface SetupTool {
  id: 'node' | 'gh' | 'gh_auth' | 'bypass' | 'chrome_default' | string
  label: string
  state: SetupState
  detail: string
  /** What `POST /v1/setup/run` runs there; absent when there is no one command. */
  command?: string
}

export const done = (it: SetupItem | undefined) => it?.state === 'ok' || it?.state === 'not_needed'

/** Nothing left to do. */
export function ready(r: SetupReport | undefined): boolean {
  return !!r && r.items.length > 0 && r.items.every(done)
}

/** The first item that is not done, which is the next step; an optional one never is. */
export function nextStep(r: SetupReport | undefined): SetupItem | undefined {
  return r?.items.find((it) => !done(it) && !it.optional)
}

/** The steps left: items not done, the optional project never among them. */
export function stepsLeft(r: SetupReport): SetupItem[] {
  return shownItems(r).filter((it) => !done(it) && !it.optional)
}

/** The agents switched on and ready: what a laptop's chips name. */
export function readyAgents(r: SetupReport | undefined): string[] {
  return (r?.agents ?? []).filter((a) => a.on && a.state === 'ok').map((a) => a.label)
}

/** The word on an agent step's button. */
export function stepWord(step: string | undefined, action?: string): string {
  if (action === 'path' || step === 'path') return 'Add to PATH'
  return step === 'signin' ? 'Sign in' : 'Install'
}

/** PUT /v1/setup/agents/<id>: an agent's switch, kept on this computer; the checklist as it now reads. */
export async function setAgentSwitch(id: string, on: boolean): Promise<SetupReport> {
  const res = await fetch(`/v1/setup/agents/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ on }),
  })
  if (!res.ok) {
    let body: unknown
    try { body = await res.json() } catch { /* not JSON */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body)
  }
  return (await res.json()) as SetupReport
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
export function stepPhrase(it: SetupItem, rep?: SetupReport): string {
  switch (it.key) {
    case 'git': return 'Git is not installed there'
    case 'agent': {
      const rows = rep?.agents
      if (!rows) return 'no agent is installed there yet'
      const a = rows.find((r) => r.on && r.state === 'missing') ?? rows.find((r) => r.on && r.state === 'unknown')
      if (!a) return 'no agent is switched on there'
      if (a.state === 'unknown') return `${a.label} may not be signed in there`
      return a.step === 'signin' ? `${a.label} is not signed in there`
        : a.step === 'path' ? `${a.label} there is not on the PATH`
          : `${a.label} is not installed there yet`
    }
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
  /** Add project opened on Clone: the checklist's *Projects here*. */
  cloneProject?: () => void
  /** A session or shell on another computer in a tab here (#1085): *Show output* of a setup step run there (#1088). */
  openRemote?: (machine: string, session: string, title?: string) => void
}

export const AppActionsContext = createContext<AppActions>({})

export function useAppActions(): AppActions {
  return useContext(AppActionsContext)
}
