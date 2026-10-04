/**
 * The last answer to a slow question, kept in this browser so a screen can show
 * it the moment it opens and replace it when the fresh one lands.
 *
 * Owner report (2026-10-04): Now sat on "reading your figures…" and dashes for
 * seconds while the daemon was busy — /v1/status took 2.2 s on his machine
 * that day. The figures from a few minutes ago are worth showing while the
 * new ones are read, as long as they say they are a few minutes old.
 *
 * Deliberately small:
 *
 *  - One entry per question (endpoint + query), the latest answer only.
 *  - An answer over MAX_ENTRY characters is not kept — a big History payload
 *    is not worth a quota error — and the total is held under MAX_TOTAL by
 *    dropping the oldest entries.
 *  - The prefix carries a version. Bump CACHE_VERSION when a cached response
 *    changes shape; entries under any other version are deleted on load, so
 *    a contract change never renders an old shape.
 *  - Every storage access is in try/catch. A private window, blocked site data
 *    or a full quota makes this a no-op, never an error on screen.
 *
 * Never for session event streams or terminal data: those are about now, and
 * a stale copy of them would be a lie about the present.
 */

export const CACHE_VERSION = 1
const ROOT = 'caprock-swr-'
const PREFIX = `${ROOT}v${CACHE_VERSION}:`
/** Characters, which is what localStorage's quota counts (UTF-16 units). */
export const MAX_ENTRY = 200_000
export const MAX_TOTAL = 1_000_000

export interface Cached<T> {
  data: T
  /** When the answer was fetched, unix ms. */
  at: number
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** Drop entries written under another cache version. Runs once per load. */
function purgeOtherVersions() {
  const s = storage()
  if (!s) return
  try {
    const stale: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k && k.startsWith(ROOT) && !k.startsWith(PREFIX)) stale.push(k)
    }
    stale.forEach((k) => s.removeItem(k))
  } catch {
    /* storage unavailable: nothing to purge */
  }
}
purgeOtherVersions()

/** The last answer to `key`, or undefined when there is none or it is unreadable. */
export function readCache<T>(key: string): Cached<T> | undefined {
  const s = storage()
  if (!s) return undefined
  try {
    const raw = s.getItem(PREFIX + key)
    if (!raw || raw.length > MAX_ENTRY) return undefined
    const v = JSON.parse(raw) as Partial<Cached<T>>
    if (!v || typeof v !== 'object' || typeof v.at !== 'number' || !('data' in v) || v.data == null) return undefined
    return { data: v.data as T, at: v.at }
  } catch {
    return undefined
  }
}

/** Keep `data` as the latest answer to `key`, within the size caps. */
export function writeCache<T>(key: string, data: T, at = Date.now()) {
  const s = storage()
  if (!s) return
  try {
    const raw = JSON.stringify({ data, at }) // `at` last: trim reads it off the tail
    if (raw.length > MAX_ENTRY) {
      s.removeItem(PREFIX + key) // an older, smaller answer would now be the wrong one
      return
    }
    s.setItem(PREFIX + key, raw)
    trim(s)
  } catch {
    /* quota or storage refused: the screen works without it */
  }
}

const AT_TAIL = /"at":(\d+)\}$/

/** Oldest entries out until the total is under MAX_TOTAL. */
function trim(s: Storage) {
  const entries: { k: string; size: number; at: number }[] = []
  let total = 0
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i)
    if (!k || !k.startsWith(PREFIX)) continue
    const raw = s.getItem(k) ?? ''
    // `at` is the last field writeCache writes, so it is read off the tail
    // rather than by parsing every kept answer on every write — that was up
    // to a megabyte of JSON.parse per refetch, on the main thread.
    const m = AT_TAIL.exec(raw.slice(-32))
    const at = m ? Number(m[1]) : 0 // unreadable: oldest
    entries.push({ k, size: raw.length, at })
    total += raw.length
  }
  entries.sort((a, b) => a.at - b.at)
  // Per-session entries are one per session ever opened: only the most
  // recently viewed GROUP_LIMITS[group] of them are kept.
  for (const [group, max] of Object.entries(GROUP_LIMITS)) {
    const inGroup = entries.filter((e) => e.k.startsWith(PREFIX + group))
    for (const e of inGroup.slice(0, Math.max(0, inGroup.length - max))) {
      s.removeItem(e.k)
      total -= e.size
      e.size = 0
    }
  }
  for (const e of entries) {
    if (total <= MAX_TOTAL) break
    if (e.size === 0) continue
    s.removeItem(e.k)
    total -= e.size
  }
}

/** Key prefixes with their own entry limit, oldest out first. */
export const GROUP_LIMITS: Record<string, number> = { 'session:': 30 }
