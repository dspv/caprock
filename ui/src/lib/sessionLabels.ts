/**
 * How a session is named and what state it is said to be in, shared by the
 * Now screen, the pulse and the app's sidebar so they never disagree.
 */
import type { Health, SessionSummary } from './api'

/**
 * The state to show. The session's status outranks its narrated health: a
 * row whose status is `ended` is ended, whatever the last narration said.
 * A card once read "idle · was responding 20h ago" for a session the API
 * listed as ended (owner report, 2026-10-05) — a live-looking state for a
 * process that was gone.
 */
export function sessionHealth(s: Pick<SessionSummary, 'status' | 'activity'>): Health {
  if (s.status === 'ended') return 'ended'
  return s.activity?.health ?? 'idle'
}

/**
 * The branch worth printing. `HEAD` is what git reports for a detached
 * checkout and what Caprock records for a folder that is not a repository at
 * all; neither is a branch, and printing it read as one. Without a commit id
 * to name, nothing is shown.
 */
export function branchLabel(branch: string | undefined | null): string {
  const b = (branch ?? '').trim()
  return b === 'HEAD' ? '' : b
}

function segments(path: string): string[] {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
}

/**
 * For paths that share a last segment, the shortest suffix that tells each
 * apart: `~/Downloads/caprock` and `~/dev/caprock` become `Downloads/caprock`
 * and `dev/caprock`. A path whose last segment is unique keeps just that.
 */
export function uniqueSuffixes(paths: string[]): Map<string, string> {
  const distinct = [...new Set(paths.filter(Boolean))]
  const segs = new Map(distinct.map((p) => [p, segments(p)]))
  const out = new Map<string, string>()
  for (const p of distinct) {
    const mine = segs.get(p)!
    let n = 1
    while (n < mine.length) {
      const suffix = mine.slice(-n).join('/')
      const clash = distinct.some((q) => q !== p && segs.get(q)!.slice(-n).join('/') === suffix)
      if (!clash) break
      n += 1
    }
    out.set(p, mine.slice(-n).join('/') || p)
  }
  return out
}

/** Where a session's project lives: its repository, else its folder. */
function rootOf(s: Pick<SessionSummary, 'repo_root' | 'cwd'>): string {
  return s.repo_root || s.cwd
}

/**
 * A project label per session: the daemon's name, unless two different
 * folders carry the same name, in which case each gets the shortest path
 * suffix that tells them apart.
 */
export function projectLabels(sessions: SessionSummary[]): Map<string, string> {
  const rootsByName = new Map<string, Set<string>>()
  for (const s of sessions) {
    const name = s.project || ''
    const set = rootsByName.get(name) ?? new Set<string>()
    set.add(rootOf(s))
    rootsByName.set(name, set)
  }
  const out = new Map<string, string>()
  for (const [name, roots] of rootsByName) {
    if (roots.size < 2) continue
    const labels = uniqueSuffixes([...roots])
    for (const s of sessions) {
      if ((s.project || '') === name) out.set(s.session_id, labels.get(rootOf(s)) ?? name)
    }
  }
  return out
}
