/**
 * A project's files, read-only: the typed client for .ai/03-contracts.md
 * § Files, and the pure helpers the file tab and the palette's "Open file…"
 * use — where a relative link in a README points, which files match what was
 * typed.
 */
import { ApiError, deviceToken } from './api'
import type { WorktreeRef } from './changes'

export interface FileContent {
  path: string
  /** The whole file's size, even when only the first MB came. */
  size: number
  text: string
  truncated?: boolean
  /** NUL bytes or not UTF-8; `text` is then empty. */
  binary?: boolean
  lang: string
}

export interface FileList {
  files: string[]
  truncated?: boolean
}

async function get<T>(path: string): Promise<T> {
  const h: Record<string, string> = { Accept: 'application/json' }
  const t = deviceToken()
  if (t) h['X-Caprock-Device'] = t
  const res = await fetch(path, { headers: h })
  if (!res.ok) {
    let b: unknown
    try { b = await res.json() } catch { /* not JSON */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, b)
  }
  return (await res.json()) as T
}

function query(ref: WorktreeRef, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra)
  if (ref.worktree) q.set('worktree', ref.worktree)
  const s = q.toString()
  return s ? `?${s}` : ''
}

export const filesApi = {
  read: (ref: WorktreeRef, path: string) =>
    get<FileContent>(`/v1/projects/${encodeURIComponent(ref.projectId)}/file${query(ref, { path })}`),
  list: (ref: WorktreeRef) =>
    get<FileList>(`/v1/projects/${encodeURIComponent(ref.projectId)}/files${query(ref)}`),
}

/** A file tab's key: the same file of the same worktree opens once. */
export function fileKey(projectId: string, worktree: string, path: string): string {
  return `file:${projectId}:${worktree}:${path}`
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function isMarkdown(path: string, lang?: string): boolean {
  return lang === 'markdown' || /\.(md|mdx|markdown)$/i.test(path)
}

/**
 * Where a link in a file points: `external` for a web or mail address, a
 * `file` path relative to the worktree for a relative link (its #anchor and
 * ?query dropped), or nothing for a link that leaves the worktree or is
 * only an anchor.
 */
export function resolveLink(fromPath: string, href: string): { external: string } | { file: string } | null {
  const h = href.trim()
  if (/^(https?:|mailto:)/i.test(h)) return { external: h }
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return null
  const bare = h.replace(/[?#].*$/, '')
  if (!bare) return null
  let decoded = bare
  try { decoded = decodeURIComponent(bare) } catch { /* keep it as written */ }
  const parts = decoded.startsWith('/') ? [] : fromPath.split('/').slice(0, -1)
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(seg)
    }
  }
  return parts.length ? { file: parts.join('/') } : null
}

/**
 * How well a path matches a typed query, 0 for not at all. Every character
 * must appear in order (fzf's subsequence); runs of consecutive characters,
 * matches in the file name and at the start of a segment score higher, and a
 * shorter path wins a tie.
 */
export function fuzzyScore(query: string, path: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return 1
  const p = path.toLowerCase()
  const nameAt = p.lastIndexOf('/') + 1
  let score = 0
  let at = -1
  let run = 0
  for (const ch of q) {
    const i = p.indexOf(ch, at + 1)
    if (i < 0) return 0
    run = i === at + 1 ? run + 1 : 0
    score += 1 + run * 2
    if (i >= nameAt) score += 2
    if (i === 0 || '/._-'.includes(p[i - 1]!)) score += 3
    at = i
  }
  if (p.slice(nameAt).includes(q)) score += 10
  return score * 1000 - Math.min(p.length, 999)
}

/** The best matches first, at most `limit`. */
export function rankFiles(files: readonly string[], query: string, limit = 50): string[] {
  if (!query.trim()) return files.slice(0, limit)
  const scored: { f: string; s: number }[] = []
  for (const f of files) {
    const s = fuzzyScore(query, f)
    if (s > 0) scored.push({ f, s })
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, limit).map((x) => x.f)
}

export function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} bytes`
}
