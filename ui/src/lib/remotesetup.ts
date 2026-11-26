/**
 * Setting a linked computer up from this one (issue #1088; the owner's pick
 * of 2026-11-26, variant A: *checklist on the computer page*).
 *
 * The owner walked to his Windows PC that day to accept Claude Code's bypass
 * warning, install Node.js and the GitHub CLI, sign the CLI in, and turn on
 * Claude in Chrome. The computer's page now lists every step, each run there
 * when it is clicked — never by itself:
 *
 * - Git and the agents switched on there, from its own checklist
 *   (`GET /v1/setup`, ADR-099), with the same commands;
 * - Node.js, the GitHub CLI, its sign-in, the bypass warning and Claude in
 *   Chrome on by default, from the same report's `tools`;
 * - two steps only its own screen can do — the Chrome extension and site
 *   sign-ins — marked done there by hand and kept on this computer
 *   (`PATCH /v1/machines/<id>` `setup_done`).
 *
 * A step with a command runs in a shell there (`POST /v1/setup/run`); its
 * state, last line and, for the GitHub sign-in, the one-time code come from
 * `GET /v1/setup/runs`. The command is always that computer's own, never
 * sent from here.
 */
import { ApiError } from './api'
import { machineBase } from './machines'
import { shownItems, stepWord, type SetupReport } from './setup'

/** A step run there (`GET /v1/setup/runs`). */
export interface SetupRun {
  /** `node`, `gh`, `gh_auth`, `git`, or `agent:<id>`. */
  key: string
  step: string
  agent?: string
  /** The shell it runs in there: *Show output* opens it. */
  shell: string
  state: 'running' | 'finished'
  line?: string
  /** The GitHub CLI's one-time code, while its sign-in waits for it. */
  code?: string
  started_at: number
}

/** The steps that need its own screen (Machine.setup_done). */
export const SCREEN_STEPS = ['chrome_extension', 'site_sign_ins'] as const
export type ScreenStep = (typeof SCREEN_STEPS)[number]

export type StepMark = 'done' | 'todo' | 'running'

export type StepAction =
  /** POST /v1/setup/run with this step (and agent). */
  | { kind: 'run'; step: string; agent?: string; word: string; signin?: boolean }
  /** Claude Code's warning, read and accepted here (POST /v1/claude/bypass-consent there). */
  | { kind: 'bypass' }
  /** Claude in Chrome's "Enabled by default" (POST /v1/setup/run chrome_default). */
  | { kind: 'chrome' }
  /** Done on its own screen: marked here by hand. */
  | { kind: 'mark'; step: ScreenStep }

export interface RemoteStep {
  key: string
  label: string
  detail: string
  mark: StepMark
  action?: StepAction
  /** Needs the computer's own screen (the amber sub-list). */
  screen?: boolean
  run?: SetupRun
}

/**
 * Every step, in the order the page lists them, from the computer's report,
 * the runs started there, and the steps marked done by hand. `runs` may be
 * absent (the sidebar counts without them).
 */
export function remoteSteps(rep: SetupReport | undefined, done: readonly string[] = [], runs: readonly SetupRun[] = []): RemoteStep[] {
  if (!rep) return []
  const byKey = new Map(runs.map((r) => [r.key, r] as const))
  const out: RemoteStep[] = []
  const add = (s: RemoteStep) => {
    const run = byKey.get(s.key)
    if (run && s.mark !== 'done') {
      s.run = run
      if (run.state === 'running') s.mark = 'running'
    }
    out.push(s)
  }
  for (const it of shownItems(rep)) {
    if (it.key !== 'git') continue
    const ok = it.state === 'ok' || it.state === 'not_needed'
    add({ key: 'git', label: 'Git', detail: it.detail, mark: ok ? 'done' : 'todo', action: !ok && it.command ? { kind: 'run', step: 'git', word: 'Install' } : undefined })
  }
  for (const a of rep.agents ?? []) {
    if (!a.on) continue
    // A sign-in Caprock cannot read (Codex in the keyring) holds nothing up.
    const ok = a.state === 'ok' || a.state === 'unknown' || a.state === 'not_needed'
    const signin = a.step === 'signin'
    add({
      key: `agent:${a.id}`,
      label: a.label,
      detail: a.detail,
      mark: ok ? 'done' : 'todo',
      action: !ok && a.command ? { kind: 'run', step: 'agent', agent: a.id, word: stepWord(a.step, a.action), signin } : undefined,
    })
  }
  const tools = rep.tools ?? []
  for (const t of tools) {
    const ok = t.state === 'ok' || t.state === 'not_needed'
    let action: StepAction | undefined
    if (!ok) {
      if (t.id === 'bypass') action = { kind: 'bypass' }
      else if (t.id === 'chrome_default') action = { kind: 'chrome' }
      else if (t.command) action = { kind: 'run', step: t.id, word: t.id === 'gh_auth' ? 'Sign in' : 'Install' }
    }
    add({ key: t.id, label: t.label, detail: t.detail, mark: ok ? 'done' : 'todo', action })
  }
  // Its own screen: only beside Claude Code there (the bypass row says it is
  // installed), whose Chrome extension and sign-ins they are.
  if (tools.some((t) => t.id === 'bypass')) {
    const marked = (k: ScreenStep) => done.includes(k)
    add({
      key: 'chrome_extension',
      label: 'Chrome extension',
      detail: 'Install Claude in Chrome in Chrome there, from the Chrome Web Store.',
      mark: marked('chrome_extension') ? 'done' : 'todo',
      action: { kind: 'mark', step: 'chrome_extension' },
      screen: true,
    })
    add({
      key: 'site_sign_ins',
      label: 'Site sign-ins',
      detail: 'Sign in to the sites agents will use, in Chrome there. Passwords never pass through Caprock.',
      mark: marked('site_sign_ins') ? 'done' : 'todo',
      action: { kind: 'mark', step: 'site_sign_ins' },
      screen: true,
    })
  }
  return out
}

/** How many are done, of how many. */
export function stepCounts(steps: readonly RemoteStep[]): { done: number; total: number; left: number } {
  const done = steps.filter((s) => s.mark === 'done').length
  return { done, total: steps.length, left: steps.length - done }
}

async function farJSON<T>(id: string, path: string, init?: RequestInit): Promise<T> {
  const write = !!init?.method && init.method !== 'GET'
  const res = await fetch(`${machineBase(id)}${path}`, { ...init, headers: { Accept: 'application/json', ...(write ? { 'Content-Type': 'application/json' } : {}) } })
  if (!res.ok) {
    let body: unknown
    try { body = await res.json() } catch { /* not JSON */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body)
  }
  return (await res.json()) as T
}

/** GET /v1/setup/runs there; a Caprock there from before them has none. */
export async function fetchRuns(id: string): Promise<SetupRun[]> {
  try {
    return (await farJSON<{ runs?: SetupRun[] }>(id, '/v1/setup/runs')).runs ?? []
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 403)) return []
    throw e
  }
}

/** POST /v1/setup/run there: one step, run there now. */
export function runStep(id: string, step: string, agent?: string): Promise<SetupRun> {
  return farJSON<SetupRun>(id, '/v1/setup/run', { method: 'POST', body: JSON.stringify(agent ? { step, agent } : { step }) })
}

/** Claude in Chrome on by default there; answers its checklist as it now reads. */
export function chromeDefaultOn(id: string): Promise<SetupReport> {
  return farJSON<SetupReport>(id, '/v1/setup/run', { method: 'POST', body: JSON.stringify({ step: 'chrome_default' }) })
}

/** Claude Code's bypass warning, accepted there (#1091). */
export function acceptBypassThere(id: string): Promise<{ accepted: boolean }> {
  return farJSON<{ accepted: boolean }>(id, '/v1/claude/bypass-consent', { method: 'POST', body: '{}' })
}

/** GitHub's device page, where the one-time code is entered. */
export const GITHUB_DEVICE_URL = 'https://github.com/login/device'

/** The words for a step that computer would not run. */
export function runError(e: unknown, name: string): string {
  if (e instanceof ApiError) {
    const b = (e.body ?? {}) as { error?: string; status?: string }
    if (e.status === 404 || e.status === 405 || (e.status === 403 && !b.status)) return `${name} cannot run this from here yet: update Caprock there.`
    if (b.status === 'offline') return `${name} is offline.`
    if (e.status === 504) return `${name} did not answer in time.`
    if (b.error) return `${name}: ${b.error}`
    return `${name} refused it (${e.status}).`
  }
  return e instanceof Error ? e.message : String(e)
}
