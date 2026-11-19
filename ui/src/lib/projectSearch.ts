/**
 * Finding a project by a few letters of its name (owner, 2026-10-10: "I want
 * to quickly search projects by repo in my folder", translated).
 *
 * One search for both sheets that ask for a project — New agent's Project
 * field and Add a project's Folder field — over three sources, deduplicated
 * by path and ranked in this order of trust:
 *
 *  1. projects already added (one keystroke from an agent),
 *  2. folders sessions have run in (`GET /v1/recent-dirs`),
 *  3. git repositories under the default folder, two levels deep
 *     (`GET /v1/browse/repos`: the daemon scans, the page never walks the disk).
 *
 * Matching is on the name first and the path second: a prefix of the name
 * beats a word inside it, which beats a substring, which beats the letters in
 * order ("cpw" finds caprock-web). Within one quality, the more trusted source
 * wins, then the one worked in last, then the shorter name. With nothing
 * typed every name matches equally, so the list is the projects by when they
 * were last worked in (owner, 2026-11-19: the shortest names — kit, ktl, MVP —
 * led it, not the projects in use).
 */

export type CandidateKind = 'project' | 'recent' | 'repo'

export interface Candidate {
  kind: CandidateKind
  /** Absolute path. */
  path: string
  name: string
  /** The project's id, for kind 'project'. */
  projectId?: string
  /** When it was last worked in (ms), the newest any source knows; absent when none says. */
  at?: number
}

export interface Ranked extends Candidate {
  /** Higher is better; 0 never appears (no match is dropped). */
  score: number
  /** Indexes into `name` that matched, for highlighting; empty for a path match. */
  hits: number[]
}

const KIND_ORDER: Record<CandidateKind, number> = { project: 0, recent: 1, repo: 2 }

/** Folds case and the separators people mix up ("caprock web" finds caprock-web). */
function fold(s: string): string {
  return s.toLowerCase().replace(/[\s_.-]+/g, '-')
}

/** The candidates from every source, a path listed once under its most trusted kind. */
export function mergeCandidates(sources: Candidate[][]): Candidate[] {
  const seen = new Map<string, Candidate>()
  for (const list of sources) {
    for (const c of list) {
      const key = c.path.replace(/[\\/]+$/, '')
      const prev = seen.get(key)
      const at = Math.max(prev?.at ?? 0, c.at ?? 0) || undefined
      if (!prev || KIND_ORDER[c.kind] < KIND_ORDER[prev.kind]) seen.set(key, { ...c, path: key, at })
      else if (at !== prev.at) seen.set(key, { ...prev, at })
    }
  }
  return [...seen.values()]
}

/** Where `q` matches in `name`, and how well; null when it does not. */
export function matchName(q: string, name: string): { score: number; hits: number[] } | null {
  const fq = fold(q)
  const fn = fold(name)
  if (!fq) return { score: 1, hits: [] }
  // fold() keeps the length of a name made of single separators, so indexes
  // into fn are indexes into name; a run of separators collapses, which only
  // shifts highlights, never the match itself.
  const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i)
  if (fn === fq) return { score: 100, hits: range(0, fq.length) }
  if (fn.startsWith(fq)) return { score: 80, hits: range(0, fq.length) }
  const word = fn.indexOf(`-${fq}`)
  if (word >= 0) return { score: 60, hits: range(word + 1, fq.length) }
  const at = fn.indexOf(fq)
  if (at >= 0) return { score: 50, hits: range(at, fq.length) }
  // The letters in order, as a fuzzy finder takes them.
  const hits: number[] = []
  let j = 0
  for (let i = 0; i < fn.length && j < fq.length; i++) {
    if (fn[i] === fq[j]) { hits.push(i); j++ }
  }
  if (j === fq.length && fq.length >= 2) return { score: 20 - Math.min(10, hits[hits.length - 1]! - hits[0]! - fq.length + 1), hits }
  return null
}

/** The query a typed path stands for: its last segment, or the whole text.
 *  A path ending in a separator ("~/dev/") is a folder still open for a
 *  name, and asks nothing yet. */
export function queryOf(text: string): string {
  const t = text.trim()
  if (/[\\/]$/.test(t)) return ''
  if (!/[\\/]/.test(t)) return t.replace(/^~$/, '')
  return t.split(/[\\/]/).pop()?.replace(/^~$/, '') ?? ''
}

/** Every candidate that matches `q`, best first. An empty query lists them all in source order.
 *  The path is matched as the user writes it, from `~`: the folders above
 *  home are the same for every candidate and would match them all. */
export function rankCandidates(q: string, candidates: Candidate[], limit = 50, home?: string): Ranked[] {
  const out: Ranked[] = []
  const fq = fold(q.trim())
  for (const c of candidates) {
    const m = matchName(q.trim(), c.name)
    if (m) { out.push({ ...c, ...m }); continue }
    // The path, for "work/api" or a parent folder's name.
    if (fq.length >= 2 && fold(tildePath(c.path, home)).includes(fq)) out.push({ ...c, score: 10, hits: [] })
  }
  out.sort((a, b) => b.score - a.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (b.at ?? 0) - (a.at ?? 0) || a.name.length - b.name.length || a.name.localeCompare(b.name))
  return out.slice(0, limit)
}

/** Edit distance, for "Did you mean": caprock-website is four edits from caprock-web. */
export function distance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]!
}

/**
 * The candidates a mistyped name most likely meant: a shared start of four or
 * more letters, or an edit distance within half the name. Best first, at most
 * `limit`.
 */
export function closest(q: string, candidates: Candidate[], limit = 3): Candidate[] {
  const fq = fold(q.trim())
  if (fq.length < 3) return []
  const scored: { c: Candidate; d: number }[] = []
  for (const c of candidates) {
    const fn = fold(c.name)
    let prefix = 0
    while (prefix < fq.length && prefix < fn.length && fq[prefix] === fn[prefix]) prefix++
    const d = distance(fq, fn)
    const near = d <= Math.max(2, Math.floor(Math.max(fq.length, fn.length) / 2))
    if (prefix >= 4 || near) scored.push({ c, d: d - prefix / 2 })
  }
  scored.sort((a, b) => a.d - b.d || KIND_ORDER[a.c.kind] - KIND_ORDER[b.c.kind])
  return scored.slice(0, limit).map((s) => s.c)
}

/** A path as the user writes it: the home folder as ~. */
export function tildePath(path: string, home?: string): string {
  if (!home) return path
  const h = home.replace(/[\\/]+$/, '')
  if (path === h) return '~'
  if (path.startsWith(`${h}/`) || path.startsWith(`${h}\\`)) return `~${path.slice(h.length)}`
  return path
}
