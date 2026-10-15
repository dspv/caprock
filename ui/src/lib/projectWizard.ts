/**
 * New project, tap-tap-tap (owner, 2026-10-14, translated: "I want big:
 * quickly click through and the project is created with everything. Or a
 * monorepo, even faster."). The rules of the wizard (components/
 * ProjectWizard.tsx) apart from its markup: which folders to offer as one
 * click, what a scan found in words, what Create sends, and how a
 * project's instructions read at a glance — the same words wherever an
 * agent is started.
 *
 * Two kinds of instructions reach an agent, and both are shown:
 *  - **Caprock's** (`defaults.system_prompt`): handed by Caprock to every
 *    Claude Code, Codex and Grok session it starts in the project.
 *  - **The repository's own** (`CLAUDE.md`, `.claude/CLAUDE.md`,
 *    `AGENTS.md`): read by the agents themselves, Caprock or not.
 */
import type { AddProjectRequest, FoundRepo, Project, ScanResult } from './projects'
import { tildePath } from './projectSearch'

/** A path without its trailing separators, `/` kept. */
export function trimSlash(p: string): string {
  const t = p.replace(/[\\/]+$/, '')
  return t || p.slice(0, 1)
}

/** The folder holding `p`, or '' at the top. */
export function parentOf(p: string): string {
  const t = trimSlash(p)
  const at = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'))
  if (at < 0) return ''
  if (at === 0) return t.slice(0, 1)
  return t.slice(0, at)
}

/** The last segment of a path. */
export function lastSegment(p: string): string {
  const t = trimSlash(p)
  return t.slice(Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\')) + 1) || t
}

/** `~/dev` → `/Users/ada/dev` when home is known; anything else as it is. */
export function expandTilde(p: string, home?: string): string {
  if (!home) return p
  const h = trimSlash(home)
  if (p === '~') return h
  if (p.startsWith('~/') || p.startsWith('~\\')) return h + p.slice(1)
  return p
}

/**
 * A typed path split for the folder list (owner, 2026-10-15, translated:
 * "search doesn't work — typing the first letters should search these
 * folders in this directory"): `dir` is the folder whose children are
 * listed, `partial` the name being typed in it. A path that ends with a
 * separator, `~` and a bare drive (`C:`) have no partial. `~/dev/cap` →
 * `~/dev/` + `cap`; `C:\Users\ada\de` → `C:\Users\ada\` + `de`; a name with
 * no folder before it (`cap`) has no `dir` and lists nothing.
 */
export function splitTyped(p: string): { dir: string; partial: string } {
  const t = p.trim()
  if (!t) return { dir: '', partial: '' }
  if (t === '~') return { dir: '~', partial: '' }
  if (/^[A-Za-z]:$/.test(t)) return { dir: `${t}\\`, partial: '' }
  const at = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'))
  if (at < 0) return { dir: '', partial: t }
  return { dir: t.slice(0, at + 1), partial: t.slice(at + 1) }
}

/** One folder the typed name matches, and where in its name. */
export interface FolderMatch<E> { entry: E; start: number; length: number }

/**
 * The folders whose names hold `partial`, ignoring case: the ones that start
 * with it first, then the ones that hold it elsewhere, each group in the
 * listing's own order (repositories first, then by name). An empty partial
 * matches everything, unmarked.
 */
export function filterFolders<E extends { name: string }>(entries: readonly E[], partial: string): FolderMatch<E>[] {
  if (!partial) return entries.map((entry) => ({ entry, start: 0, length: 0 }))
  const q = partial.toLowerCase()
  const starts: FolderMatch<E>[] = []
  const holds: FolderMatch<E>[] = []
  for (const entry of entries) {
    const at = entry.name.toLowerCase().indexOf(q)
    if (at === 0) starts.push({ entry, start: 0, length: partial.length })
    else if (at > 0) holds.push({ entry, start: at, length: partial.length })
  }
  return [...starts, ...holds]
}

/**
 * The field after Tab on a folder: its path in `~` form and a separator, so
 * the next letters search inside it. The separator is the path's own: `\`
 * for a Windows path, `/` everywhere else.
 */
export function drillPath(path: string, home?: string): string {
  const t = tildePath(path, home)
  if (t.endsWith('/') || t.endsWith('\\')) return t
  return t + (path.includes('\\') && !path.includes('/') ? '\\' : '/')
}

/**
 * The folders offered as one click: where projects already live (the
 * parents of their roots, most projects first), then the default folder and
 * the home folder. In `~` form, at most `limit`, never the filesystem root.
 */
export function placeChips(roots: readonly string[], opts: { home?: string; defaultFolder?: string; limit?: number } = {}): string[] {
  const { home, defaultFolder, limit = 5 } = opts
  const counts = new Map<string, number>()
  const order: string[] = []
  for (const r of roots) {
    if (!r) continue
    const parent = parentOf(r)
    if (!parent || parent === '/' || /^[A-Za-z]:\\?$/.test(parent)) continue
    const key = tildePath(parent, home)
    if (!counts.has(key)) order.push(key)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const ranked = order.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
  const extra = [defaultFolder ? tildePath(trimSlash(defaultFolder), home) : '', '~'].filter(Boolean)
  const out: string[] = []
  for (const c of [...ranked, ...extra]) {
    if (!out.includes(c)) out.push(c)
  }
  // The home folder stays last, whatever the cap.
  const capped = out.filter((c) => c !== '~').slice(0, Math.max(0, limit - 1))
  return [...capped, '~']
}

/** What a scan found, as the wizard says it. */
export type Found =
  /** One repository: the folder is it, or is inside it. */
  | { kind: 'repo'; path: string; name: string; inside: boolean }
  /** Two or more repositories below the folder. */
  | { kind: 'multi'; root: string; repos: FoundRepo[]; capped: boolean }
  /** Exactly one repository below the folder: the wizard looks at it instead. */
  | { kind: 'one-below'; repo: FoundRepo }
  /** No repository at all: a plain folder. */
  | { kind: 'folder'; path: string; name: string }

export function foundOf(scan: ScanResult): Found {
  if (scan.repo_root) {
    return { kind: 'repo', path: scan.repo_root, name: lastSegment(scan.repo_root), inside: trimSlash(scan.repo_root) !== trimSlash(scan.root) }
  }
  if (scan.repos.length >= 2) return { kind: 'multi', root: scan.root, repos: scan.repos, capped: !!scan.capped }
  if (scan.repos.length === 1) return { kind: 'one-below', repo: scan.repos[0]! }
  return { kind: 'folder', path: scan.root, name: lastSegment(scan.root) }
}

/** The big line at the top of the second step. */
export function foundHeadline(f: Found, picked = 0): string {
  switch (f.kind) {
    case 'repo': return 'One repository'
    case 'folder': return 'A plain folder'
    case 'one-below': return 'One repository'
    case 'multi': return `${f.repos.length} repositories${f.capped ? ' or more' : ''}${picked !== f.repos.length ? ` · ${picked} picked` : ''}`
  }
}

/** The project already listed at `path`, if any. */
export function listedAt(projects: readonly Project[], path: string): Project | undefined {
  const want = trimSlash(path)
  return projects.find((p) => !p.archived_at && p.root && trimSlash(p.root) === want)
}

export type Shape = 'one' | 'separate'

/**
 * What Create sends. A multi-repo folder with two or more picked is one
 * project of them (or one each); a single pick is that repository alone.
 */
export function createRequests(f: Found, picked: readonly string[], shape: Shape): AddProjectRequest[] | string {
  if (f.kind === 'repo') return [{ path: f.path }]
  if (f.kind === 'folder') return [{ path: f.path }]
  if (f.kind === 'one-below') return [{ path: f.repo.path }]
  if (picked.length === 0) return 'Pick at least one repository.'
  if (picked.length === 1) return [{ path: picked[0]! }]
  if (shape === 'separate') return picked.map((path) => ({ path }))
  return [{ path: f.root, repos: [...picked] }]
}

/** The Create button's words. */
export function createLabel(f: Found, picked: number, shape: Shape, listed: boolean): string {
  if (listed) return 'Open project'
  if (f.kind !== 'multi' || picked < 2) return 'Create project'
  return shape === 'separate' ? `Create ${picked} projects` : `Create project of ${picked} repos`
}

/** How many lines a text has, a trailing newline not counted. */
export function lineCount(text: string): number {
  const t = text.replace(/\s+$/, '')
  return t ? t.split('\n').length : 0
}

/** Caprock's instructions at a glance: "Set · 12 lines", or "None". */
export function instructionsState(prompt: string | undefined): { set: boolean; label: string } {
  const n = lineCount(prompt ?? '')
  return n > 0 ? { set: true, label: `Set · ${n} line${n === 1 ? '' : 's'}` } : { set: false, label: 'None' }
}

/** The repository's own files in a few words: "CLAUDE.md, AGENTS.md", "CLAUDE.md in api, web". */
export function repoFilesLabel(files: readonly string[] | undefined): string {
  if (!files || files.length === 0) return ''
  const top = files.filter((f) => !isMemberFile(f))
  const byName = new Map<string, string[]>()
  for (const f of files.filter(isMemberFile)) {
    const { member, name } = splitMemberFile(f)
    byName.set(name, [...(byName.get(name) ?? []), member])
  }
  const parts = [...top]
  for (const [name, members] of byName) {
    parts.push(`${name} in ${members.length > 3 ? `${members.slice(0, 3).join(', ')} +${members.length - 3}` : members.join(', ')}`)
  }
  return parts.join(' · ')
}

/** A member's file (`api/CLAUDE.md`), as opposed to one at the root (`CLAUDE.md`, `.claude/CLAUDE.md`). */
export function isMemberFile(f: string): boolean {
  return f.includes('/') && !f.startsWith('.claude/')
}

/** `services/web/.claude/CLAUDE.md` → member `services/web`, name `.claude/CLAUDE.md`. */
export function splitMemberFile(f: string): { member: string; name: string } {
  for (const n of ['.claude/CLAUDE.md', 'CLAUDE.md', 'AGENTS.md']) {
    if (f.endsWith(`/${n}`)) return { member: f.slice(0, -n.length - 1), name: n }
  }
  return { member: '', name: f }
}

/**
 * The project's one line of instructions state, for a list or a tooltip:
 * what Caprock hands its agents, and what the repository tells them itself.
 */
export function instructionsSummary(p: Pick<Project, 'defaults' | 'instruction_files'>): { kind: 'set' | 'repo' | 'none'; text: string } {
  const own = instructionsState(p.defaults?.system_prompt)
  const files = repoFilesLabel(p.instruction_files)
  if (own.set) return { kind: 'set', text: files ? `Instructions: ${own.label.toLowerCase()} · repo has ${files}` : `Instructions: ${own.label.toLowerCase()}` }
  if (files) return { kind: 'repo', text: `Instructions: none from Caprock · repo has ${files}` }
  return { kind: 'none', text: 'Instructions: none' }
}

/** "3 repos: api, web, infra", for a multi-repo project under its name. */
export function membersLine(repos: readonly { name: string }[] | undefined, max = 6): string {
  if (!repos || repos.length === 0) return ''
  const names = repos.map((r) => r.name)
  const shown = names.length > max ? `${names.slice(0, max).join(', ')} +${names.length - max}` : names.join(', ')
  return `${repos.length} repo${repos.length === 1 ? '' : 's'}: ${shown}`
}
