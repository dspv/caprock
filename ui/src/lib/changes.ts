/**
 * A worktree's changes: the typed client for .ai/03-contracts.md § Changes,
 * and the pure helpers the Changes view draws with (diff rows for the
 * unified and side-by-side layouts, a commit message from the agent's last
 * words).
 */
import { ApiError, deviceToken } from './api'
import { parsePatch } from './patch'

export interface ChangeFile {
  path: string
  orig_path?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted'
  additions: number
  deletions: number
  binary?: boolean
}

export interface Changes {
  project_id: number
  worktree: string
  path: string
  branch: string
  detached?: boolean
  head?: string
  upstream?: string
  ahead: number
  behind: number
  remote?: string
  remote_url?: string
  default_branch?: string
  published: boolean
  state?: string
  staged: ChangeFile[]
  unstaged: ChangeFile[]
  conflicted: ChangeFile[]
  truncated?: boolean
  token: string
  at: number
}

export interface FilePatch {
  path: string
  orig_path?: string
  staged: boolean
  status: string
  patch: string
  binary?: boolean
  truncated?: boolean
  too_large?: boolean
  bytes: number
  token: string
}

export interface CommitResult { sha: string; short: string; subject: string; output?: string }
export interface RemoteResult { remote?: string; branch?: string; upstream_set?: boolean; output?: string }
export interface DiscardPreview { confirm: string; files: ChangeFile[] }
export interface Hunk { path: string; index: number; token: string }

/** Which worktree: a project, and git's name for a linked worktree ('' = the main checkout). */
export interface WorktreeRef {
  projectId: string
  worktree: string
}

/** What went wrong, as the daemon said it: the message, its kind, and git's or a hook's output. */
export interface ChangeFailure {
  message: string
  kind?: string
  output?: string
  preview?: DiscardPreview
  status?: number
}

export function failureOf(e: unknown): ChangeFailure {
  if (e instanceof ApiError) {
    const b = (e.body ?? {}) as { error?: string; detail?: string; kind?: string; output?: string; preview?: DiscardPreview }
    const message = b.error ? (b.detail ? `${b.error} — ${b.detail}` : b.error) : e.message
    return { message, kind: b.kind, output: b.output, preview: b.preview, status: e.status }
  }
  return { message: e instanceof Error ? e.message : String(e) }
}

function base(ref: WorktreeRef, sub = ''): string {
  const q = ref.worktree ? `?worktree=${encodeURIComponent(ref.worktree)}` : ''
  return `/v1/projects/${encodeURIComponent(ref.projectId)}/changes${sub}${q}`
}

async function send<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const h: Record<string, string> = { Accept: 'application/json' }
  if (method === 'POST') h['Content-Type'] = 'application/json'
  const t = deviceToken()
  if (t) h['X-Caprock-Device'] = t
  const res = await fetch(path, { method, headers: h, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined })
  if (!res.ok) {
    let b: unknown
    try { b = await res.json() } catch { /* not JSON */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, b)
  }
  return (await res.json()) as T
}

export const changesApi = {
  status: (ref: WorktreeRef) => send<Changes>(base(ref), 'GET'),
  diff: (ref: WorktreeRef, path: string, staged: boolean) => {
    const sep = ref.worktree ? '&' : '?'
    return send<FilePatch>(`${base(ref, '/diff')}${sep}path=${encodeURIComponent(path)}${staged ? '&staged=1' : ''}`, 'GET')
  },
  stage: (ref: WorktreeRef, req: { paths?: string[]; all?: boolean; hunk?: Hunk }) =>
    send<{ changes: Changes }>(base(ref, '/stage'), 'POST', req).then((r) => r.changes),
  unstage: (ref: WorktreeRef, req: { paths?: string[]; all?: boolean; hunk?: Hunk }) =>
    send<{ changes: Changes }>(base(ref, '/unstage'), 'POST', req).then((r) => r.changes),
  /** The first call returns what would go and a token; the second, with it, discards. */
  discard: (ref: WorktreeRef, paths: string[], confirm?: string) =>
    send<{ preview?: DiscardPreview; changes?: Changes }>(base(ref, '/discard'), 'POST', confirm ? { paths, confirm } : { paths }),
  commit: (ref: WorktreeRef, message: string, all: boolean) =>
    send<{ commit: CommitResult; changes: Changes }>(base(ref, '/commit'), 'POST', { message, all }),
  push: (ref: WorktreeRef) => send<{ result: RemoteResult; changes: Changes }>(base(ref, '/push'), 'POST'),
  pull: (ref: WorktreeRef) => send<{ result: RemoteResult; changes: Changes }>(base(ref, '/pull'), 'POST'),
  fetch: (ref: WorktreeRef) => send<{ result: RemoteResult; changes: Changes }>(base(ref, '/fetch'), 'POST'),
}

/** Every file the status lists, in the order the view lists them. */
export interface ChangeEntry {
  key: string
  area: 'conflicted' | 'staged' | 'unstaged'
  file: ChangeFile
}

export function entriesOf(c: Changes | undefined): ChangeEntry[] {
  if (!c) return []
  return [
    ...c.conflicted.map((file) => ({ key: `c:${file.path}`, area: 'conflicted' as const, file })),
    ...c.staged.map((file) => ({ key: `s:${file.path}`, area: 'staged' as const, file })),
    ...c.unstaged.map((file) => ({ key: `u:${file.path}`, area: 'unstaged' as const, file })),
  ]
}

export function changedCount(c: Changes | undefined): number {
  if (!c) return 0
  return new Set([...c.staged, ...c.unstaged, ...c.conflicted].map((f) => f.path)).size
}

// ── Diff rows ──────────────────────────────────────────────────────────────

/** One drawn row of a unified diff. `hunk` is the index of the hunk it is in (-1 before the first). */
export interface UnifiedRow {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'
  text: string
  old?: number
  new?: number
  hunk: number
}

export function unifiedRows(patch: string): UnifiedRow[] {
  let hunk = -1
  return parsePatch(patch).map((l) => {
    if (l.kind === 'hunk') hunk += 1
    return { kind: l.kind, text: l.kind === 'hunk' || l.kind === 'meta' ? l.text : l.text.slice(1), old: l.old, new: l.new, hunk }
  })
}

/** One cell of a side-by-side row. */
export interface SideCell {
  kind: 'add' | 'del' | 'ctx'
  text: string
  n: number
}

/** One drawn row of a side-by-side diff: a header across both sides, or the two sides of a line. */
export type SplitRow =
  | { kind: 'hunk' | 'meta'; text: string; hunk: number }
  | { kind: 'line'; left?: SideCell; right?: SideCell; hunk: number }

/**
 * A unified diff laid out in two columns: context on both sides, and within a
 * hunk each run of removed lines beside the run of added lines that follows
 * it, row by row, the shorter run padded.
 */
export function splitRows(rows: UnifiedRow[]): SplitRow[] {
  const out: SplitRow[] = []
  let dels: UnifiedRow[] = []
  let adds: UnifiedRow[] = []
  const flush = () => {
    const n = Math.max(dels.length, adds.length)
    for (let i = 0; i < n; i++) {
      const d = dels[i]
      const a = adds[i]
      out.push({
        kind: 'line',
        hunk: (d ?? a)!.hunk,
        left: d ? { kind: 'del', text: d.text, n: d.old ?? 0 } : undefined,
        right: a ? { kind: 'add', text: a.text, n: a.new ?? 0 } : undefined,
      })
    }
    dels = []
    adds = []
  }
  for (const r of rows) {
    if (r.kind === 'del') {
      if (adds.length > 0) flush()
      dels.push(r)
    } else if (r.kind === 'add') {
      adds.push(r)
    } else {
      flush()
      if (r.kind === 'ctx') {
        out.push({ kind: 'line', hunk: r.hunk, left: { kind: 'ctx', text: r.text, n: r.old ?? 0 }, right: { kind: 'ctx', text: r.text, n: r.new ?? 0 } })
      } else {
        out.push({ kind: r.kind, text: r.text, hunk: r.hunk })
      }
    }
  }
  flush()
  return out
}

/** A patch drawn only when asked: past this many lines, or this many bytes. */
export const LARGE_DIFF_LINES = 3000
export const LARGE_DIFF_BYTES = 400 * 1024

export function isLargePatch(p: Pick<FilePatch, 'patch' | 'bytes'>): boolean {
  if (p.bytes > LARGE_DIFF_BYTES) return true
  let n = 0
  for (let i = p.patch.indexOf('\n'); i >= 0; i = p.patch.indexOf('\n', i + 1)) {
    if (++n > LARGE_DIFF_LINES) return true
  }
  return false
}

// ── A commit message from the agent's last words ───────────────────────────

const SUBJECT_MAX = 72

/**
 * A commit message drafted from what the agent said last: its first line as
 * the subject (markdown dropped, cut at a word under 72 characters), the rest
 * as the body. Only a draft — the box stays editable.
 */
export function messageFromSummary(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''))
  const plain = (l: string) => l
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
  const first = lines.findIndex((l) => plain(l) !== '')
  if (first < 0) return ''
  let subject = plain(lines[first]!)
  // "I fixed the bug. Then I ran the tests." → its first sentence; the rest
  // of the line opens the body.
  let rest = ''
  const stop = subject.search(/[.!?]\s/)
  if (stop > 0) {
    rest = subject.slice(stop + 1).trim()
    subject = subject.slice(0, stop)
  }
  subject = subject.replace(/[:.]$/, '')
  if (subject.length > SUBJECT_MAX) {
    const cut = subject.lastIndexOf(' ', SUBJECT_MAX - 1)
    subject = `${subject.slice(0, cut > 20 ? cut : SUBJECT_MAX - 1)}…`
  }
  const body = [rest, ...lines.slice(first + 1)].join('\n').replace(/^\n+|\n+$/g, '').slice(0, 2000)
  return body ? `${subject}\n\n${body}` : subject
}
