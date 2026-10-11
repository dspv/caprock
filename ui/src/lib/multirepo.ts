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
