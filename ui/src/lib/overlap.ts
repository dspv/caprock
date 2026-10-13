/**
 * Two live sessions in one checkout (owner, 2026-10-14, translated: "agents'
 * work is duplicated. Different sessions, one project … a decision is
 * needed"). The decision: don't block it, show it and help.
 *
 * - **Same checkout** — the same clone or the same linked worktree, not two
 *   worktrees of one repository — marks each row with a quiet chip naming
 *   the other session.
 * - **Files edited by both** in the last 30 minutes (Edit, Write, MultiEdit,
 *   NotebookEdit) is the real collision risk: the chip becomes a warning,
 *   "N files touched by both", with the list on hover.
 * - **One way out**: *Move to a worktree…* opens the New session dialog for
 *   a new copy of the folder, named after the newer session. Nothing moves
 *   by itself, and Caprock never types into a session (CLAUDE.md rule 7).
 *
 * The daemon groups and compares (`GET /v1/overlap`, one query on the files
 * table, only for sessions that share a checkout); the screens ask only when
 * two live sessions could share one at all.
 */
import { api, type Overlap, type OverlapPeer, type SessionSummary } from './api'
import { useApi } from './useApi'
import { SLOW_LIVE_MS } from './refresh'
import { promptTitle } from './sessionNames'
import { shortId } from './format'

const NONE: Overlap = { window_minutes: 30, sessions: {} }

/**
 * Whether two of these live sessions could share a checkout: the same
 * repository (or, outside one, the same folder). Without it nobody asks the
 * daemon anything.
 */
export function mayShare(sessions: readonly Pick<SessionSummary, 'status' | 'repo_root' | 'cwd'>[]): boolean {
  const seen = new Set<string>()
  for (const s of sessions) {
    if (s.status === 'ended') continue
    const k = (s.repo_root || s.cwd || '').replace(/\\/g, '/')
    if (!k) continue
    if (seen.has(k)) return true
    seen.add(k)
  }
  return false
}

/** `GET /v1/overlap` at the slow pace, shared by every reader; nothing asked while `enabled` is false. */
export function useOverlap(enabled: boolean): Overlap {
  const got = useApi(() => (enabled ? api.overlap() : Promise.resolve(NONE)), [enabled], {
    live: enabled,
    liveMs: SLOW_LIVE_MS,
    share: enabled ? 'overlap' : false,
    keepUnchanged: true,
  })
  return (enabled && got.data) || NONE
}

/** A neighbour's name as its row says it: the user's, the agent's title, else a few words of its first prompt. */
export function peerName(p: Pick<OverlapPeer, 'name' | 'name_source' | 'session_id'>): string {
  const n = p.name_source === 'prompt' ? promptTitle(p.name) : p.name.trim()
  return n || shortId(p.session_id)
}

/** A file under the checkout, written relative to it. */
export function relPath(file: string, checkout: string): string {
  const f = file.replace(/\\/g, '/')
  const c = checkout.replace(/\\/g, '/').replace(/\/+$/, '')
  return c && f.startsWith(c + '/') ? f.slice(c.length + 1) : f
}

export interface OverlapChip {
  /** `warn` when files were edited by both; `info` when they share only the folder. */
  tone: 'warn' | 'info'
  label: string
  /** The hover: who, and every file both touched. */
  title: string
  /** Files edited by this session and a neighbour, relative to the checkout. */
  files: string[]
  checkout: string
  /** The session to move: the one that started last among this one and its neighbours. */
  newer: { session_id: string; name: string }
}

/** What a session's row says about its neighbours in the checkout; undefined when it has none. */
export function overlapChip(o: Overlap, s: Pick<SessionSummary, 'session_id' | 'started_at'>, ownName: string): OverlapChip | undefined {
  const entry = o.sessions[s.session_id]
  if (!entry || entry.with.length === 0) return undefined
  const names = entry.with.map(peerName)
  const files = [...new Set(entry.with.flatMap((p) => p.files.map((f) => relPath(f, entry.checkout))))].sort()
  const who = names.length === 1 ? names[0]! : `${names[0]} and ${names.length - 1} more`
  let newer = { session_id: s.session_id, name: ownName, started_at: s.started_at }
  for (const p of entry.with) if (p.started_at > newer.started_at) newer = { session_id: p.session_id, name: peerName(p), started_at: p.started_at }
  const where = `in ${entry.checkout}`
  if (files.length === 0) {
    return {
      tone: 'info',
      label: `shares checkout with ${who}`,
      title: `${names.join(', ')} ${names.length === 1 ? 'works' : 'work'} ${where} too. No file edited by both in the last ${o.window_minutes} minutes.`,
      files, checkout: entry.checkout, newer: { session_id: newer.session_id, name: newer.name },
    }
  }
  return {
    tone: 'warn',
    label: `${files.length} file${files.length === 1 ? '' : 's'} touched by both`,
    title: `Edited by this session and ${names.join(', ')} ${where} in the last ${o.window_minutes} minutes — one can write over the other:\n${files.join('\n')}`,
    files, checkout: entry.checkout, newer: { session_id: newer.session_id, name: newer.name },
  }
}
