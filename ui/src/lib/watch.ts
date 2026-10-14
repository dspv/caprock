/**
 * Watch: a YouTube link played in a tab of its own while agents work
 * (an experiment; .ai/04-ui.md § Watch, ADR-062's note).
 *
 * Owner, 2026-10-14 (translated): "Let's try adding YouTube watching
 * somewhere." The survey beside it asks whether anyone wants this; the tab
 * lets someone try it.
 *
 * Rule 4: nothing is fetched from YouTube until a link is pasted and Play
 * pressed. The player is the privacy-enhanced embed
 * (www.youtube-nocookie.com), the only frame source the daemon's page allows
 * (internal/api/ui.go) and the only one the desktop shell lets a frame load
 * (app/src-tauri/src/shell.rs). There is no search: it would need an API key
 * and a call to Google on every keystroke.
 *
 * Everything here is pure, so it is tested without a player: reading a link,
 * the embed's address, the few links kept in this browser, and which waiting
 * session is new since the last look.
 */

/** A link read: a video, a playlist, or a video inside a playlist. */
export interface WatchLink {
  video?: string
  list?: string
  /** Seconds into the video, from `t=` or `start=`. */
  start?: number
}

/** The embed's host: the privacy-enhanced player, nothing else. */
export const EMBED_ORIGIN = 'https://www.youtube-nocookie.com'

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const LIST_ID = /^[A-Za-z0-9_-]{2,64}$/
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'])

/** `90`, `90s`, `1m30s`, `1h2m3s` → seconds; anything else → undefined. */
export function parseStart(t: string | null): number | undefined {
  if (!t) return undefined
  if (/^\d+s?$/.test(t)) return Number.parseInt(t, 10) || undefined
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t)
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined
  const s = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  return s > 0 ? s : undefined
}

/**
 * What a pasted text points at, or null when it is not a YouTube video or
 * playlist: watch, youtu.be, shorts, live, embed and playlist links, with or
 * without the scheme, and a bare eleven-character video id.
 */
export function parseYouTube(input: string): WatchLink | null {
  const text = input.trim()
  if (!text) return null
  if (VIDEO_ID.test(text)) return { video: text }
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)
  const q = url.searchParams
  const list = q.get('list') ?? undefined
  const start = parseStart(q.get('t') ?? q.get('start'))
  const out = (video: string | undefined): WatchLink | null => {
    const v = video && VIDEO_ID.test(video) ? video : undefined
    const l = list && LIST_ID.test(list) ? list : undefined
    if (!v && !l) return null
    const r: WatchLink = {}
    if (v) r.video = v
    if (l) r.list = l
    if (v && start) r.start = start
    return r
  }
  if (host === 'youtu.be' || host === 'www.youtu.be') return out(parts[0])
  if (!YT_HOSTS.has(host)) return null
  switch (parts[0]) {
    case 'watch': return out(q.get('v') ?? undefined)
    case 'shorts':
    case 'live':
    case 'embed':
    case 'v':
      return parts[1] === 'videoseries' ? out(undefined) : out(parts[1])
    case 'playlist': return out(undefined)
    default: return null
  }
}

/**
 * The player's address. `enablejsapi` and `origin` let this page send it
 * `pauseVideo` (and only this page: the player answers the origin named);
 * `autoplay` because the user has just pressed Play.
 */
export function embedSrc(l: WatchLink, origin: string): string {
  const p = new URLSearchParams()
  if (l.list) p.set('list', l.list)
  if (l.start) p.set('start', String(l.start))
  p.set('autoplay', '1')
  p.set('playsinline', '1')
  p.set('rel', '0')
  p.set('enablejsapi', '1')
  if (origin && origin !== 'null') p.set('origin', origin)
  return `${EMBED_ORIGIN}/embed/${l.video ?? 'videoseries'}?${p.toString()}`
}

/** A link as it is kept and shown in the recent list: short, and the same however it was pasted. */
export function canonicalLink(l: WatchLink): string {
  if (l.video) {
    const p = new URLSearchParams()
    if (l.list) p.set('list', l.list)
    if (l.start) p.set('t', String(l.start))
    const s = p.toString()
    return `https://youtu.be/${l.video}${s ? `?${s}` : ''}`
  }
  return `https://www.youtube.com/playlist?list=${l.list ?? ''}`
}

/** The IFrame Player API's pause, as a message to the player frame. */
export const PAUSE_MESSAGE = JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] })

// ---- what this browser keeps (a per-viewer convenience, never shared) ----

const KEY = 'caprock.watch'

/** How many recent links are kept. */
export const RECENT_MAX = 5

export interface WatchPrefs {
  /** Recent links, newest first, canonical form. */
  recent: string[]
  /** Pause the video when an agent turns to waiting on you. Default on. */
  pause: boolean
}

export function readWatchPrefs(): WatchPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<WatchPrefs> | null
    const recent = Array.isArray(v?.recent) ? v.recent.filter((x): x is string => typeof x === 'string' && !!parseYouTube(x)).slice(0, RECENT_MAX) : []
    return { recent, pause: v?.pause !== false }
  } catch {
    return { recent: [], pause: true }
  }
}

export function saveWatchPrefs(p: WatchPrefs) {
  try { localStorage.setItem(KEY, JSON.stringify(p)) } catch { /* storage refused: it lasts the page */ }
}

/** `link` first in the recent list, once, at most RECENT_MAX kept. */
export function withRecent(recent: readonly string[], link: string): string[] {
  return [link, ...recent.filter((r) => r !== link)].slice(0, RECENT_MAX)
}

// ---- the nudge: an agent turned to waiting on you ----

/** A session waiting on the user, as the strip names it. */
export interface WaitItem {
  sessionId: string
  title: string
  reason: 'permission' | 'waiting'
  /** When it started waiting, unix ms: a session waiting again later is new again. */
  since: number
}

/** One wait, told apart from the same session's next one. */
export function waitKey(w: WaitItem): string {
  return `${w.sessionId}:${w.reason}:${w.since}`
}

/**
 * The waits that began after `after` (when the tab opened) and were not seen
 * before, newest first. What was already waiting when the tab opened is left
 * out: the strip is for a turn that ends while the video plays, not for a
 * backlog the sidebar and the badge already show.
 */
export function freshWaits(seen: ReadonlySet<string>, items: readonly WaitItem[], after: number): WaitItem[] {
  return items.filter((w) => w.since > after && !seen.has(waitKey(w))).sort((a, b) => b.since - a.since)
}

/** The strip's words for a wait. */
export function waitLine(w: WaitItem): string {
  return w.reason === 'permission' ? `${w.title} needs your permission` : `${w.title} is waiting for you`
}
