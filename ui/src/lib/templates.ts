/**
 * New project from a template (ADR-065; contract in .ai/03-contracts.md §
 * Project templates): the wire types and the pure parts of the dialog —
 * reading what was typed as a GitHub repository, the first prompt with its
 * brief path, how the project will be made with the gh this machine has,
 * what Create will do and send, and the progress of the operation.
 *
 * Nothing here talks to the daemon; `api` in lib/api.ts does.
 */
import type { OpFrame } from './projects'

/** A saved template (`GET /v1/templates`). */
export interface Template {
  id: string
  name: string
  /** `owner/name` of a GitHub template repository. */
  github?: string
  /** A folder on this machine. */
  folder?: string
  /** Where the brief is written in the new project, relative. */
  brief_path: string
  /** The first prompt; `{brief}` is the brief's path. */
  prompt: string
  agent?: string
  created_at: number
  used_at?: number
}

/** What a POST or PATCH /v1/templates takes; on a PATCH `""` clears github, folder or agent. */
export interface TemplateInput {
  name?: string
  github?: string
  folder?: string
  brief_path?: string
  prompt?: string
  agent?: string
}

/** The person's own GitHub CLI, read from its config on this machine. */
export interface GHStatus {
  installed: boolean
  logged_in: boolean
  login?: string
  error?: string
}

/** `POST /v1/templates/inspect`: what a template says about itself. */
export interface Inspection {
  github?: string
  folder?: string
  is_template?: boolean
  visibility?: string
  template_md: string
  brief_path: string
  brief_from: 'marker' | 'mention' | 'default'
  prompt: string
  prompt_from: 'marker' | 'default'
  /** A clone of the repository directly in the default folder. */
  local_folder?: string
  suggested_name: string
  error?: string
}

export type Via = 'github' | 'local'
export type Visibility = 'private' | 'public'

/** `POST /v1/projects/from-template`. */
export interface CreateRequest {
  op_id: string
  source: { github?: string; folder?: string }
  via: Via
  name: string
  parent: string
  visibility?: Visibility
  brief: string
  brief_path: string
  template_name?: string
}

export type TemplateStep = 'create' | 'clone' | 'copy' | 'brief' | 'commit' | 'add'

/** A `template` operation: a clone's op frame and what only these carry. */
export type TemplateOp = OpFrame & {
  kind: 'template'
  step?: TemplateStep
  repo?: string
  repo_url?: string
  notes?: string[]
  retryable?: boolean
  removed?: boolean
}

export function isTemplateOp(op: OpFrame | undefined): op is TemplateOp {
  return op?.kind === 'template'
}

const GITHUB_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

/**
 * `owner/name` from what was typed: `owner/name`, a github.com URL (with or
 * without the scheme, `.git`, a trailing slash or a path past the name), or
 * `git@github.com:owner/name.git`. Null for anything else, so the daemon is
 * never asked about a string it would refuse.
 */
export function normalizeGitHub(input: string): string | null {
  let s = input.trim()
  if (!s) return null
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/](.+)$/i.exec(s)
  if (ssh) s = ssh[1]!
  else {
    s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
    if (/^github\.com\//i.test(s)) s = s.slice('github.com/'.length)
    else if (/^[^/]*\.[^/]*\//.test(s) || s.includes(':') || s.includes('@')) return null // another host
  }
  s = s.replace(/[?#].*$/, '')
  const parts = s.split('/').filter(Boolean)
  if (parts.length < 2) return null
  if (parts.length > 2 && !/^(tree|blob|issues|pulls|actions|wiki|releases)$/.test(parts[2]!)) return null
  const owner = parts[0]!
  const name = parts[1]!.replace(/\.git$/i, '')
  if (name === '.' || name === '..') return null
  const out = `${owner}/${name}`
  return GITHUB_RE.test(out) ? out : null
}

/** The first prompt as the agent gets it: every `{brief}` is the brief's path. */
export function fillPrompt(prompt: string, briefPath: string): string {
  return prompt.split('{brief}').join(briefPath)
}

/** A folder or repository name the daemon takes (the CreateRequest's `name`). */
export function nameProblem(name: string): string {
  const n = name.trim()
  if (!n) return 'Name it.'
  if (n === '.' || n === '..' || !/^[A-Za-z0-9._-]{1,100}$/.test(n)) return 'Letters, digits, dot, dash and underscore only, at most 100.'
  return ''
}

/** `new-<base>`, numbered while that is taken. */
export function suggestName(base: string, taken: ReadonlySet<string>): string {
  const b = `new-${base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'}`
  if (!taken.has(b)) return b
  for (let i = 2; i < 1000; i++) if (!taken.has(`${b}-${i}`)) return `${b}-${i}`
  return b
}

/** The last segment of `owner/name` or of a folder. */
export function baseOf(source: { github?: string; folder?: string }): string {
  if (source.github) return source.github.split('/')[1] ?? source.github
  const f = (source.folder ?? '').replace(/[\\/]+$/, '')
  return f.slice(Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\')) + 1) || f
}

/**
 * How the project will be made, from the template and the gh this machine
 * has. The daemon never picks the local copy by itself (ADR-065), and
 * neither does this: a GitHub template with gh signed out waits for the
 * person, who may ask for the local copy (`local`).
 *
 * - github, gh signed in: on GitHub.
 * - a folder only: a local copy, whatever gh is.
 * - github and a folder (saved, or a clone in the default folder), gh not
 *   installed: a local copy, saying how to have one made on GitHub.
 * - github, gh not installed, no folder: nothing can be made.
 * - github, gh signed out: waits; a local copy when asked and a folder is known.
 */
export type HowMade =
  | { kind: 'github'; via: 'github'; login: string }
  | { kind: 'folder'; via: 'local'; folder: string }
  | { kind: 'no-gh'; via: 'local'; folder: string }
  | { kind: 'signed-out'; via: 'local' | null; folder?: string }
  | { kind: 'none'; via: null }

export function howMade(t: { github?: string; folder?: string; localFolder?: string }, gh: GHStatus | undefined, local = false): HowMade {
  const folder = t.folder || t.localFolder || undefined
  if (!t.github) return t.folder ? { kind: 'folder', via: 'local', folder: t.folder } : { kind: 'none', via: null }
  if (gh?.installed && gh.logged_in) return { kind: 'github', via: 'github', login: gh.login ?? '' }
  if (gh?.installed) return { kind: 'signed-out', via: local && folder ? 'local' : null, folder }
  return folder ? { kind: 'no-gh', via: 'local', folder } : { kind: 'none', via: null }
}

/** The line under the name: how it will be made, in words. */
export function howMadeLine(h: HowMade, p: { github?: string; name: string; dest: string }): string {
  switch (h.kind) {
    case 'github': return `On GitHub as ${h.login}/${p.name}, from ${p.github}, then cloned to ${p.dest}.`
    case 'folder': return `A copy of ${h.folder} at ${p.dest}: a new repository with one commit. Nothing goes to GitHub.`
    case 'no-gh': return `gh is not installed, so it is made on this computer: a copy of ${h.folder} at ${p.dest}, a new repository with one commit. Install gh and run \`gh auth login\` to have one made.`
    case 'signed-out': return h.via === 'local'
      ? `Made on this computer: a copy of ${h.folder} at ${p.dest}, a new repository with one commit. Run \`gh auth login\` to have one made on GitHub.`
      : `gh is installed but not signed in, so it cannot make the repository on GitHub. Run \`gh auth login\`, then Check again${h.folder ? ` — or make it locally from ${h.folder}` : '.'}`
    case 'none': return `${p.github} is on GitHub and gh is not installed here, and there is no copy of it in your folder. Install gh and run \`gh auth login\`, then Check again.`
  }
}

/** One line of "When you press Create": a command shown as code, then words. */
export interface PlanLine { code?: string; text: string }

/** What Create will do, in order, and what leaves the machine (rule 4). */
export function planLines(p: {
  via: Via
  login?: string
  name: string
  github?: string
  folder?: string
  visibility: Visibility
  dest: string
  briefPath: string
  agent: string
  prompt: string
}): { steps: PlanLine[]; sent: string } {
  const last: PlanLine[] = [
    { text: `Writes your brief to ${p.briefPath} and commits it. Not pushed.` },
    { text: `Starts ${p.agent} there with: “${fillPrompt(p.prompt, p.briefPath)}”` },
  ]
  if (p.via === 'github') {
    return {
      steps: [
        { code: `gh repo create ${p.login || '<you>'}/${p.name} --template ${p.github} --${p.visibility}`, text: `makes a ${p.visibility} repository on GitHub with your gh login.` },
        { text: `Clones it to ${p.dest}.` },
        ...last,
      ],
      sent: 'Sent to GitHub: the name and visibility. Your brief stays on this computer until you push.',
    }
  }
  return {
    steps: [
      { text: `Copies ${p.folder} to ${p.dest} — its last commit, when it is a repository.` },
      { text: 'Makes it a new repository: git init and one commit.' },
      ...last,
    ],
    sent: 'Nothing leaves this computer.',
  }
}

/** The footer's line while the operation runs; `starting` once it is done and the agent is being started. */
export function progressLine(op: TemplateOp | undefined, agent: string, starting = false): string {
  if (starting || op?.state === 'done') return `Starting ${agent}…`
  switch (op?.step) {
    case 'create': return 'Creating the repository on GitHub…'
    case 'clone': return op.progress && op.progress > 0 ? `Cloning… ${op.progress}%` : 'Cloning…'
    case 'copy': return 'Copying the template…'
    case 'brief': return 'Writing the brief…'
    case 'commit': return 'Committing the brief…'
    case 'add': return 'Adding the project…'
    default: return 'Starting…'
  }
}

function shortHome(p: string, home?: string): string {
  if (!home) return p
  const h = home.replace(/[\\/]+$/, '')
  return p === h ? '~' : p.startsWith(`${h}/`) || p.startsWith(`${h}\\`) ? `~${p.slice(h.length)}` : p
}

function sentence(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ')
  return /[.!?…]$/.test(t) ? t : `${t}.`
}

/** What a failed operation says, and whether Retry and Open on GitHub are offered. */
export function failureView(op: TemplateOp, home?: string): { text: string; retry: boolean; repoUrl?: string; keep?: string } {
  const err = (op.error ?? '').trim() || 'it failed'
  const dest = shortHome(op.dest ?? '', home)
  const keep = op.repo_url ? 'Caprock never deletes a GitHub repository; delete it there if you don’t want it.' : undefined
  if (op.step === 'create' && !op.repo_url) {
    return { text: `GitHub did not make the repository: ${sentence(err)} Nothing was created.`, retry: !!op.retryable }
  }
  if (op.step === 'clone' && op.repo_url) {
    return {
      text: `The repository is on GitHub (${op.repo_url}), but the clone failed: ${sentence(err)}${op.removed ? ` ${dest} was removed.` : ''}`,
      retry: !!op.retryable, repoUrl: op.repo_url, keep,
    }
  }
  return { text: sentence(err), retry: !!op.retryable, repoUrl: op.repo_url, keep }
}

/** The toast when the project is ready: its name, where it lives, and the daemon's notes. */
export function readyLine(name: string, op: TemplateOp): string {
  const where = op.repo ? ` — github.com/${op.repo}` : ''
  const notes = (op.notes ?? []).filter(Boolean)
  return `${name} is ready${where}${notes.length ? `. ${notes.join(' ')}` : ''}`
}

/** A brief may come from a file dropped on the field: Markdown or text, at most 1 MiB. */
export const MAX_BRIEF_BYTES = 1 << 20
export function isBriefFile(name: string): boolean {
  return /\.(md|markdown|txt)$/i.test(name)
}

/** The job the app keeps once Create is pressed, so a hidden dialog still ends in an agent. */
export interface TemplateJob {
  op_id: string
  name: string
  agent: string
  agentLabel: string
  /** The first prompt, `{brief}` already replaced. */
  prompt: string
  via: Via
  /** The template to save once the project is made; absent when not ticked. */
  save?: { name: string; github?: string; folder?: string; brief_path: string; prompt: string; agent?: string }
  /** What "When you press Create" said, shown again while it runs. */
  plan: { steps: PlanLine[]; sent: string }
  /** Set once the op is done and the agent is being started. */
  starting?: boolean
  /** The agent did not start after the project was made. */
  agentError?: string
  projectId?: string
  cwd?: string
}
