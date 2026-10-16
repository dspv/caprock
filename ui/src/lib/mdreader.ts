/**
 * Reading a Markdown file in a file tab, and handing it on (.ai/04-ui.md §
 * The app workspace, File tabs): the outline the contents rail lists, the
 * anchors its headings take, the reference an agent reads a file by, the
 * `.md` paths an agent prints in its chat and terminal, and where such a
 * path lives among the projects Caprock knows.
 *
 * Every "link" here is a path on this machine. Nothing is uploaded or
 * hosted (CLAUDE.md rule 4).
 */
import { api, ApiError, deviceToken } from './api'
import type { WorktreeRef } from './changes'

/**
 * The reference Claude Code, Codex and the others accept for a file in a
 * prompt: `@` and the absolute path, in double quotes when it holds a space.
 */
export function agentRef(abs: string): string {
  return /\s/.test(abs) ? `@"${abs.replace(/"/g, '\\"')}"` : `@${abs}`
}

/**
 * A heading's anchor as GitHub names it: lower case, punctuation dropped,
 * spaces to hyphens; a repeat takes `-1`, `-2`. `seen` carries the repeats
 * across one document.
 */
export function slugOf(text: string, seen: Map<string, number>): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-') || 'section'
  const n = seen.get(base) ?? 0
  seen.set(base, n + 1)
  return n === 0 ? base : `${base}-${n}`
}

/** One entry of a document's contents. */
export interface OutlineItem {
  level: number
  text: string
  slug: string
}

/**
 * The headings of a document as the contents lists them: levels one to
 * three, indented from the shallowest present.
 */
export function outlineOf(headings: readonly OutlineItem[]): OutlineItem[] {
  const shown = headings.filter((h) => h.level <= 3)
  const top = Math.min(...shown.map((h) => h.level))
  return shown.map((h) => ({ ...h, level: h.level - top + 1 }))
}

/**
 * The `.md` paths in a run of text: absolute (`/Users/…/PLAN.md`, `C:\…`),
 * home-relative (`~/notes.md`) or relative (`docs/setup.md`, `./a.md`),
 * with an optional `:line` after, or after an `@`. Never the tail of a URL.
 */
const MD_PATH = /(?<![\w/\\.~%-])(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@+-]+[\\/])*[\w@+-][\w.@+-]*\.(?:md|mdx|markdown)(?::\d+)?(?![\w/\\-])/g

export interface PathHit {
  start: number
  end: number
  /** The path as printed, without any `:line`. */
  path: string
}

export function mdPathsIn(text: string): PathHit[] {
  const out: PathHit[] = []
  MD_PATH.lastIndex = 0
  for (let m = MD_PATH.exec(text); m; m = MD_PATH.exec(text)) {
    // An agent's own `@path` reference: the path is what follows the `@`.
    const at = m[0].startsWith('@') ? 1 : 0
    out.push({ start: m.index + at, end: m.index + m[0].length, path: m[0].slice(at).replace(/:\d+$/, '') })
  }
  return out
}

/** A folder a file may be opened from: a project's checkout or a linked worktree. */
export interface FileRoot {
  projectId: string
  /** git's name for a linked worktree; '' for the main checkout. */
  worktree: string
  folder: string
}

function norm(p: string): string {
  const s = p.replace(/\\/g, '/')
  const parts: string[] = []
  const lead = s.startsWith('/') ? '/' : ''
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return lead + parts.join('/')
}

const isAbs = (p: string) => p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)

/**
 * Where a printed path lives: the root that holds it (the deepest, so a
 * linked worktree inside its repository wins) and the path inside it. A
 * relative path is read against `cwd`, the session's folder; `~` against
 * `home` when known. Nothing outside a known root opens.
 */
export function locateFile(raw: string, cwd: string, roots: readonly FileRoot[], home = ''): (WorktreeRef & { path: string }) | null {
  let p = raw.trim()
  if (/^~[\\/]/.test(p)) {
    if (!home) return null
    p = `${home}/${p.slice(2)}`
  } else if (!isAbs(p)) {
    if (!cwd) return null
    p = `${cwd}/${p}`
  }
  const abs = norm(p)
  const fold = (s: string) => (/^[A-Za-z]:/.test(s) ? s.toLowerCase() : s)
  let best: (WorktreeRef & { path: string; depth: number }) | null = null
  for (const r of roots) {
    if (!r.folder) continue
    const f = norm(r.folder)
    if (!fold(abs).startsWith(`${fold(f)}/`)) continue
    if (best && f.length <= best.depth) continue
    best = { projectId: r.projectId, worktree: r.worktree, path: abs.slice(f.length + 1), depth: f.length }
  }
  if (!best) return null
  const { depth: _d, ...hit } = best
  return hit
}

/** The event an agent's printed `.md` path raises when clicked; the workspace opens it. */
export const OPEN_PATH_EVENT = 'caprock:open-path'

export interface OpenPathDetail {
  path: string
  /** The session that printed it: its folder resolves a relative path. */
  sessionId: string
}

export function requestOpenPath(detail: OpenPathDetail): void {
  window.dispatchEvent(new CustomEvent<OpenPathDetail>(OPEN_PATH_EVENT, { detail }))
}

/** Why a reference was not typed in. */
export class SendRefError extends Error {}

/**
 * Types `@<path> ` into a session Caprock started, without Enter, so the
 * user adds words before sending. Refuses while the session waits on a
 * permission prompt: the text would land in the agent's menu. Rule 7: the
 * caller offers only owned live sessions, and the daemon refuses input for
 * any other id anyway.
 */
export async function sendRef(sessionId: string, abs: string): Promise<void> {
  const waiting = await api.permission(sessionId).then((r) => r.permission !== null).catch(() => false)
  if (waiting) throw new SendRefError('The agent is waiting on a permission prompt. Answer it first, then send again.')
  await api.agentInput(sessionId, `${agentRef(abs)} `)
}

/** The bytes of a picture inside the project, as an object URL for an `<img>`; the caller revokes it. */
export async function imageUrl(ref: WorktreeRef, path: string): Promise<string> {
  const q = new URLSearchParams({ path })
  if (ref.worktree) q.set('worktree', ref.worktree)
  const h: Record<string, string> = {}
  const t = deviceToken()
  if (t) h['X-Caprock-Device'] = t
  const res = await fetch(`/v1/projects/${encodeURIComponent(ref.projectId)}/image?${q}`, { headers: h })
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`, undefined)
  return URL.createObjectURL(await res.blob())
}

/** Puts `text` on the clipboard; false when the page may not. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Saves `text` as a file: the browser's downloads, or the app's save dialog (its download handler). */
export function downloadText(text: string, name: string, type = 'text/markdown'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
