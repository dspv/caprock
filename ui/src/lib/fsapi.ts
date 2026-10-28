/**
 * The Files tab (ADR-089): the typed client for .ai/03-contracts.md § Files
 * tab, and the pure helpers its two panels use — the action keys, paths,
 * the "what the agent changed" filter.
 */
import { ApiError, deviceToken } from './api'
import type { KeyLike } from './appkeys'

export interface FsEntry {
  name: string
  dir?: boolean
  link?: boolean
  size: number
  /** Unix ms. */
  mtime: number
  /** M A D U ? from git status; . on a folder with a change inside; ! ignored. */
  git?: string
}

export interface FsListing {
  path: string
  root: string
  entries: FsEntry[]
  truncated?: boolean
  git: boolean
  branch?: string
  /** False on a paired device: Files is read-only there. */
  writable: boolean
  /** Why Delete is off on this machine; absent when the Trash works. */
  trash_off?: string
}

export type CompareState = 'diff' | 'left' | 'right'

export interface FsCompare {
  path: string
  states: Record<string, CompareState>
  unknown?: string[]
  partial?: boolean
}

export interface FsChanged {
  base: string
  changes: { path: string; status: string }[]
}

export interface FsDiff {
  path: string
  left: boolean
  right: boolean
  same?: boolean
  patch: string
  additions: number
  deletions: number
  binary?: boolean
  too_large?: boolean
  truncated?: boolean
}

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' }
  if (json) h['Content-Type'] = 'application/json'
  const t = deviceToken()
  if (t) h['X-Caprock-Device'] = t
  return h
}

async function send<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { headers: headers() } : { method: 'POST', headers: headers(true), body: JSON.stringify(body) })
  if (!res.ok) {
    let b: unknown
    try { b = await res.json() } catch { /* not JSON */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, b)
  }
  return (await res.json()) as T
}

function q(params: Record<string, string | undefined>): string {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v)
  const t = s.toString()
  return t ? `?${t}` : ''
}

const base = (projectId: string) => `/v1/projects/${encodeURIComponent(projectId)}/fs`

export const fsApi = {
  list: (projectId: string, worktree: string, path: string) =>
    send<FsListing>(`${base(projectId)}/list${q({ worktree, path })}`),
  compare: (projectId: string, left: string, right: string, path: string) =>
    send<FsCompare>(`${base(projectId)}/compare${q({ worktree: left, other: right || undefined, path })}`),
  changed: (projectId: string, worktree: string, baseWt: string) =>
    send<FsChanged>(`${base(projectId)}/changed${q({ worktree, base: baseWt })}`),
  diff: (projectId: string, left: string, right: string, path: string) =>
    send<FsDiff>(`${base(projectId)}/diff${q({ worktree: left, other: right || undefined, path })}`),
  copy: (projectId: string, b: { from: string; paths: string[]; to: string; dir: string; overwrite?: boolean }) =>
    send<{ done: number }>(`${base(projectId)}/copy`, b),
  move: (projectId: string, b: { from: string; paths: string[]; to: string; dir: string; name?: string }) =>
    send<{ done: number }>(`${base(projectId)}/move`, b),
  mkdir: (projectId: string, b: { worktree: string; dir: string; name: string }) =>
    send<{ done: number }>(`${base(projectId)}/mkdir`, b),
  trash: (projectId: string, b: { worktree: string; paths: string[] }) =>
    send<{ done: number }>(`${base(projectId)}/trash`, b),
}

/** The names a 409 `exists` answer says are taken, or null for any other failure. */
export function takenNames(e: unknown): string[] | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null
  const b = e.body as { kind?: string; exists?: string[] } | undefined
  return b?.kind === 'exists' && Array.isArray(b.exists) ? b.exists : null
}

export type FilesActionId = 'view' | 'edit' | 'copy' | 'move' | 'mkdir' | 'delete'

/**
 * The action bar, in Norton Commander's order and numbers: F3 view, F4
 * edit, F5 copy, F6 move, F7 make a folder, F8 delete. On a Mac the top row
 * is media keys unless fn is held, so each is also ⌥ with its digit (Alt
 * with it elsewhere); `key` is the macOS spelling, `keys()` writes it.
 */
export const FILES_ACTIONS: readonly { id: FilesActionId; digit: number; key: string; label: string }[] = [
  { id: 'view', digit: 3, key: '⌥3', label: 'View' },
  { id: 'edit', digit: 4, key: '⌥4', label: 'Edit' },
  { id: 'copy', digit: 5, key: '⌥5', label: 'Copy' },
  { id: 'move', digit: 6, key: '⌥6', label: 'Move' },
  { id: 'mkdir', digit: 7, key: '⌥7', label: 'New folder' },
  { id: 'delete', digit: 8, key: '⌥8', label: 'Delete' },
]

/**
 * Which Files action a key press is: F3–F8 with no modifier, or Option
 * (Alt) with the digit — read from the key's code, since Option turns 3
 * into £ on a Mac. ⌘ and Ctrl with a digit are tabs, never these.
 */
export function filesAction(e: KeyLike, _isMac: boolean): FilesActionId | null {
  if (e.metaKey || e.ctrlKey) return null
  const f = /^F([3-8])$/.exec(e.key)
  if (f && !e.altKey && !e.shiftKey) return FILES_ACTIONS.find((a) => a.digit === Number(f[1]))?.id ?? null
  const d = /^Digit([3-8])$/.exec(e.code ?? '')
  if (d && e.altKey && !e.shiftKey) return FILES_ACTIONS.find((a) => a.digit === Number(d[1]))?.id ?? null
  return null
}

/** A relative path's child, in slash form; "" is the root. */
export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/** The folder above a relative path; "" above a top-level one. */
export function parentRel(dir: string): string {
  const i = dir.lastIndexOf('/')
  return i < 0 ? '' : dir.slice(0, i)
}

/** An absolute path on this machine: a root joined with a relative path, in the root's own separators. */
export function absPath(root: string, rel: string): string {
  if (!rel) return root
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${sep === '\\' ? rel.replace(/\//g, '\\') : rel}`
}

/**
 * The names a folder keeps under the "what the agent changed" filter: a
 * changed file there, or a folder holding one.
 */
export function changedNames(changed: readonly string[], dir: string): Set<string> {
  const prefix = dir ? `${dir}/` : ''
  const out = new Set<string>()
  for (const p of changed) {
    if (!p.startsWith(prefix)) continue
    const rest = p.slice(prefix.length)
    const name = rest.split('/')[0]
    if (name) out.add(name)
  }
  return out
}

/** A size as a file manager writes it: bytes up to a KB, then one decimal under ten. */
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** A modification time: "Today, 14:12", else "Oct 27, 23:18", else with the year. */
export function fmtDate(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const n = new Date(now)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === n.toDateString()) return `Today, ${hm}`
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return d.getFullYear() === n.getFullYear() ? `${md}, ${hm}` : `${md} ${d.getFullYear()}`
}

/** How a unified diff line is drawn: a hunk header, an addition, a removal or context. */
export function diffLineKind(line: string): 'hunk' | 'add' | 'del' | 'ctx' {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

/** Kept per viewer: the Files tab's look, Caprock's palette or Norton's. */
export const FILES_LOOK_KEY = 'caprock.files.look'
export type FilesLook = 'caprock' | 'norton'

export function loadLook(): FilesLook {
  try { return localStorage.getItem(FILES_LOOK_KEY) === 'norton' ? 'norton' : 'caprock' } catch { return 'caprock' }
}

export function saveLook(l: FilesLook): void {
  try { localStorage.setItem(FILES_LOOK_KEY, l) } catch { /* private window */ }
}
