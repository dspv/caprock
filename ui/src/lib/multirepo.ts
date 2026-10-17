/**
 * Multi-repo projects (ADR-055): the rules of the Add project sheet's
 * question and of the project editor, apart from their markup.
 *
 * Adding a folder that holds several git repositories (two levels deep at
 * most, `GET /v1/projects/scan`) asks once: one project of N repositories,
 * or N separate projects. One project is the default; each repository found
 * is a checkbox, ticked unless another project already holds it as a member.
 */
import type { AddProjectRequest, FoundRepo, Project, ScanResult } from './projects'

export type AddChoice = 'one' | 'separate'

/** Whether the sheet asks: the folder is not inside a repository and holds two or more. */
export function worthAsking(scan: ScanResult | null | undefined): boolean {
  return !!scan && !scan.repo_root && scan.repos.length >= 2
}

/** The repositories ticked at first: all, except one already in a multi-repo project. */
export function defaultPicked(repos: readonly FoundRepo[]): string[] {
  return repos.filter((r) => !r.member_of).map((r) => r.path)
}

/** What each found repository already is, in a few words, or ''. */
export function foundNote(r: FoundRepo): string {
  if (r.member_of) return 'in another project'
  if (r.project_id) return r.project_name ? `listed as ${r.project_name}` : 'listed'
  return ''
}

/**
 * The requests that add what was chosen, in order: one multi-repo project
 * of the ticked repositories, or each ticked repository on its own. An error
 * sentence instead when the choice cannot be added.
 */
export function addRequests(choice: AddChoice, root: string, picked: readonly string[]): AddProjectRequest[] | string {
  if (picked.length === 0) return 'Tick a repository to add.'
  if (choice === 'one') {
    if (picked.length < 2) return 'One project needs two repositories or more; add a single one as its own project.'
    return [{ path: root, repos: [...picked] }]
  }
  return picked.map((path) => ({ path }))
}

/** The Add button's words for the choice. */
export function addLabel(choice: AddChoice, picked: number): string {
  if (choice === 'one') return 'Add 1 project'
  return `Add ${picked} project${picked === 1 ? '' : 's'}`
}

/** "3 repositories", for a multi-repo project's line. */
export function reposLabel(n: number): string {
  return `${n} repositor${n === 1 ? 'y' : 'ies'}`
}

/** Whether a project is a multi-repo one. */
export function isMultiRepo(p: Pick<Project, 'repos'> | undefined): boolean {
  return !!p?.repos && p.repos.length > 0
}

/**
 * The editor's member list after Rescan: the members kept (ticked) plus the
 * repositories ticked among those found; a member missing on disk stays
 * until unticked, so nothing disappears unasked.
 */
export function editedRepos(current: readonly string[], found: readonly FoundRepo[], ticked: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const p of current) if (ticked.has(p)) out.push(p)
  for (const r of found) if (ticked.has(r.path) && !out.includes(r.path)) out.push(r.path)
  return out
}

/** The projects a multi-repo project can be merged with: other repositories, and not another multi-repo project. */
export function mergeCandidates(project: Project, all: readonly Project[]): Project[] {
  return all.filter((p) => p.id !== project.id && !p.archived_at && p.kind === 'repo' && !isMultiRepo(p))
}

/**
 * The repositories a project holds after *Add a repository…* (ADR-077): its
 * members, then the ones ticked. A plain project has none yet: the daemon
 * puts a repository project's own root among them.
 */
export function addedRepos(project: Pick<Project, 'repos'>, ticked: readonly string[]): string[] {
  const out = (project.repos ?? []).map((r) => r.path)
  for (const p of ticked) if (!out.includes(p)) out.push(p)
  return out
}

/** Whether `path` is a project's home repository: its root, when the root is one of its repositories (ADR-077). */
export function isHomeRepo(project: Pick<Project, 'root' | 'repos'>, path: string): boolean {
  return path === project.root && (project.repos ?? []).some((r) => r.path === path)
}

/** One place New agent can start in a project of several repositories. */
export interface RepoChoice { path: string; label: string }

/**
 * Where New agent can start in a project of several repositories: a folder
 * project's own folder first (it reaches every repository below it), then
 * each repository, the home one first. Empty for any other project.
 */
export function repoChoices(project: Pick<Project, 'root' | 'repos'> | undefined): RepoChoice[] {
  const repos = project?.repos ?? []
  if (!project || repos.length === 0) return []
  const out: RepoChoice[] = []
  const home = repos.find((r) => r.path === project.root)
  if (home) out.push({ path: home.path, label: `${home.name} · home` })
  else out.push({ path: project.root, label: 'The folder · reaches every repository' })
  for (const r of repos) if (r.path !== project.root) out.push({ path: r.path, label: r.name })
  return out
}

/**
 * The repository a session row names in a project of several repositories
 * (ADR-077): the member holding its folder, '' in any other project or
 * outside every member.
 */
export function rowRepo(project: Pick<Project, 'repos'>, cwd: string | undefined): string {
  if (!cwd || !project.repos?.length) return ''
  let best: { path: string; name: string } | undefined
  for (const r of project.repos) {
    if ((cwd === r.path || cwd.startsWith(`${r.path}/`) || cwd.startsWith(`${r.path}\\`)) && (!best || r.path.length > best.path.length)) best = r
  }
  return best?.name ?? ''
}
