/**
 * A project's copies — every git worktree, with what removing one would lose
 * and how much disk it takes — and cleaning them up (.ai/03-contracts.md
 * § Projects and shells). The calls are `projectsApi.copies` and
 * `projectsApi.removeCopies` (lib/projects); the sheet is
 * components/CopiesSheet.
 *
 * Finished copies — Caprock's, merged, pushed, clean and idle — clean
 * themselves up, asking first by default (`GET /v1/projects/{id}/cleanup`;
 * components/CleanupLine): Off, Ask or Auto in Settings → Worktrees.
 */
import { fmtBytes } from './format'

/** One worktree on the wire (projects.Copy). */
export interface ProjectCopy {
  name?: string
  path: string
  main?: boolean
  branch?: string
  head?: string
  detached?: boolean
  caprock: boolean
  locked?: boolean
  missing?: boolean
  /** Unix seconds of the newest commit; absent when unknown. */
  committed_at?: number
  merged: boolean
  unpushed: number
  orphaned?: number
  dirty: boolean
  changed: number
  live: string[]
  /** Bytes; null while measured, and always for the main checkout. */
  size: number | null
  size_capped?: boolean
  /** Caprock's copy with no commit for 14 days and no pull request known: suggested, never removed for it. */
  stale?: boolean
  error?: string
}

export interface CopiesView {
  copies: ProjectCopy[]
  default_branch?: string
  has_remote: boolean
  total: number
  pending?: boolean
  capped?: boolean
}

export interface CopyRemoved {
  path: string
  removed: boolean
  branch_deleted?: string
  confirm?: boolean
  error?: string
}

export type CleanupMode = 'off' | 'ask' | 'auto'

/** One finished copy (projects.CleanupCandidate). */
export interface CleanupCandidate {
  path: string
  branch: string
  size: number | null
  size_capped?: boolean
  /** Unix ms it became one; `due`, in Auto mode, when it is removed. */
  since: number
  due?: number
  /** The merged pull request that made it one, when git alone did not. */
  pr?: number
}

/** One removed copy in the history (projects.CleanupRecord). */
export interface CleanupRecord {
  id: string
  project_id: number
  path: string
  branch?: string
  head?: string
  bytes: number
  /** Unix ms. */
  at: number
  how: 'auto' | 'ask' | 'manual'
  branch_deleted?: boolean
  restored_at?: number
  restorable: boolean
}

export interface CleanupView {
  mode: CleanupMode
  candidates: CleanupCandidate[]
  total: number
  pending?: boolean
  /** Cleaned up in the last day and not restored: the "Removed · Undo" line. */
  removed: CleanupRecord[]
  /** This project's removals, newest first. */
  history: CleanupRecord[]
  checked_at: number
}

export interface CleanupRestored {
  id: string
  path?: string
  restored: boolean
  error?: string
}

/** A wire view made safe to read: lists always lists. */
export function cleanupOf(v: Partial<CleanupView> | null | undefined): CleanupView {
  const list = <T,>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : [])
  return {
    mode: v?.mode === 'off' || v?.mode === 'auto' ? v.mode : 'ask',
    candidates: list(v?.candidates).filter((c) => c && typeof c.path === 'string'),
    total: typeof v?.total === 'number' ? v.total : 0,
    pending: !!v?.pending,
    removed: list(v?.removed).filter((r) => r && typeof r.id === 'string'),
    history: list(v?.history).filter((r) => r && typeof r.id === 'string'),
    checked_at: v?.checked_at ?? 0,
  }
}

/** "3 copies", "1 copy". */
export function copiesText(n: number): string {
  return n === 1 ? '1 copy' : `${n} copies`
}

/** The removed copies' bytes, summed. */
export function freedOf(list: CleanupRecord[]): number {
  return list.reduce((n, r) => n + (r.bytes || 0), 0)
}

/** "in 18 h", "in 40 min", "soon": when an Auto-mode candidate goes. */
export function dueText(due: number, now: number): string {
  const ms = due - now
  if (ms <= 60_000) return 'soon'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `in ${min} min`
  return `in ${Math.round(min / 60)} h`
}

/** The last folder of a path, either separator. */
export function baseOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** Why a copy cannot be removed from here, or null when it can. */
export function blockedReason(c: ProjectCopy): string | null {
  if (c.main) return 'The main checkout is never removed.'
  if (!c.caprock) return 'Made outside Caprock, so Caprock leaves it to you (git worktree remove).'
  if (c.locked) return 'Locked in git (git worktree unlock first).'
  if (c.live.length > 0) return `${cap(c.live.join(', '))} running in it. Stop it first.`
  return null
}

/** What removing a copy would lose, one phrase each; empty when nothing. */
export function lossOf(c: ProjectCopy, hasRemote: boolean): string[] {
  const out: string[] = []
  if (c.dirty) out.push(`${plural(c.changed || 1, 'uncommitted change', 'uncommitted changes')} (deleted with the folder)`)
  if (hasRemote && c.unpushed > 0 && !c.detached) out.push(`${plural(c.unpushed, 'commit', 'commits')} on no remote (kept on ${c.branch ? `branch ${c.branch}` : 'its branch'})`)
  if ((c.orphaned ?? 0) > 0) out.push(`${plural(c.orphaned!, 'commit', 'commits')} on no branch (left only in the reflog)`)
  return out
}

/** The copy's size as the list shows it: "…" while measured, "≥" for a floor. */
export function sizeText(c: ProjectCopy): string {
  if (c.main || c.missing) return '—'
  if (c.size === null || c.size === undefined) return '…'
  return `${c.size_capped ? '≥ ' : ''}${fmtBytes(c.size)}`
}

/** A copy that is safe to pick in one go: removable, merged and losing nothing. */
export function isSafePick(c: ProjectCopy, hasRemote: boolean): boolean {
  return blockedReason(c) === null && (c.merged || !!c.missing) && lossOf(c, hasRemote).length === 0
}

/** A copy's path as the list shows it: relative to the main checkout when it
 * lies inside it (Caprock's own `.caprock-worktrees/…`), else whole. */
export function shortPath(path: string, root: string): string {
  if (!root || path === root) return path
  for (const sep of ['/', '\\']) {
    const prefix = root.endsWith(sep) ? root : root + sep
    if (path.startsWith(prefix)) return path.slice(prefix.length)
  }
  return path
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
