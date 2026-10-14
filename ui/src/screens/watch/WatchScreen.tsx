/**
 * Watch: paste a YouTube link, watch it while agents work, and hear about it
 * when one of them needs you (lib/watch.ts; .ai/04-ui.md § Watch). An
 * experiment beside the YouTube survey (ADR-062).
 *
 * In the app it is a tab of its own (AppShell, like Mail) and is handed the
 * sidebar's waiting list; in the browser it is the #/watch screen and asks
 * the daemon for the live sessions itself, every few seconds while open.
 *
 * Nothing loads from YouTube before Play: until then there is no frame at
 * all. When an agent turns to waiting on the user after the tab opened, a
 * strip over the player names it with Go, and — unless switched off — the
 * video is paused through the IFrame Player API's postMessage. No script from
 * YouTube is loaded into this page; the player frame is all there is.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type SessionSummary } from '@/lib/api'
import { sessionHealth } from '@/lib/sessionLabels'
import { sessionTitle, STALE_MS } from '@/lib/sidebar'
import {
  canonicalLink, embedSrc, EMBED_ORIGIN, freshWaits, parseYouTube, PAUSE_MESSAGE,
  readWatchPrefs, saveWatchPrefs, waitKey, waitLine, withRecent,
  type WaitItem, type WatchLink, type WatchPrefs,
} from '@/lib/watch'

/** The one line on where the video comes from, and why there is no search. */
export const WATCH_SOURCE_LINE = 'The video comes from YouTube (youtube-nocookie.com), only after you press Play. No search here — it would need a YouTube API key; paste a link.'

/** How often the browser's #/watch asks for the live sessions. */
const BROWSER_POLL_MS = 3000

export function WatchScreen({ waiting, onGo }: {
  /** The sessions waiting on the user (the app's sidebar inbox); absent in the browser, which asks itself. */
  waiting?: readonly WaitItem[]
  /** Bring a waiting session to the front; absent: open its session page. */
  onGo?: (sessionId: string) => void
}) {
  const polled = useBrowserWaits(waiting === undefined)
  const items = waiting ?? polled
  const [prefs, setPrefs] = useState<WatchPrefs>(readWatchPrefs)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState<WatchLink | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const nudge = useWaitNudge(items ?? undefined)

  const update = useCallback((p: WatchPrefs) => { setPrefs(p); saveWatchPrefs(p) }, [])

  const play = useCallback((raw: string) => {
    const l = parseYouTube(raw)
    if (!l) { setError('That is not a YouTube video or playlist link.'); return }
    setError('')
    const link = canonicalLink(l)
    setText(link)
    setPlaying(l)
    update({ ...prefs, recent: withRecent(prefs.recent, link) })
  }, [prefs, update])

  // A new wait while a video plays: pause it, if that is wanted.
  const pauseFor = nudge.latest ? waitKey(nudge.latest) : ''
  useEffect(() => {
    if (!pauseFor || !playing || !prefs.pause) return
    try { frame.current?.contentWindow?.postMessage(PAUSE_MESSAGE, EMBED_ORIGIN) } catch { /* the frame is gone */ }
  }, [pauseFor, playing, prefs.pause])

  const go = (id: string) => {
    nudge.dismiss()
    if (onGo) onGo(id)
    else location.hash = `#/session/${encodeURIComponent(id)}`
  }

  const src = useMemo(() => (playing ? embedSrc(playing, location.origin) : ''), [playing])

  return (
    <div data-watch-view className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); play(text) }}
      >
        <input
          type="url"
          inputMode="url"
          aria-label="YouTube link"
          placeholder="Paste a YouTube link — a video, a Short or a playlist"
          value={text}
          onChange={(e) => { setText(e.target.value); setError('') }}
          className="h-9 min-w-0 flex-1 basis-[280px] rounded-[8px] border border-[var(--app-hairline-strong)] bg-panel px-3 text-[13px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={!text.trim()}
          className="h-9 shrink-0 rounded-[8px] bg-accent px-4 text-[13px] font-medium text-bg disabled:opacity-40"
        >
          Play
        </button>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[12.5px] text-fg-muted">
          <input
            type="checkbox"
            checked={prefs.pause}
            onChange={(e) => update({ ...prefs, pause: e.target.checked })}
            className="accent-[var(--color-accent)]"
          />
          Pause when an agent needs me
        </label>
      </form>
      <p data-watch-source className="-mt-1 text-[11.5px] text-fg-faint">{WATCH_SOURCE_LINE}</p>
      {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
      {prefs.recent.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Recent links">
          <span className="text-[11.5px] text-fg-faint">Recent</span>
          {prefs.recent.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => play(r)}
              title={r}
              className="max-w-[260px] truncate rounded-[6px] border border-[var(--app-hairline)] px-2 py-0.5 text-[11.5px] text-fg-muted hover:border-[var(--app-hairline-strong)] hover:text-fg"
            >
              {r.replace(/^https:\/\/(www\.)?/, '')}
            </button>
          ))}
        </div>
      )}
      <div className="relative mx-auto w-full max-w-[1100px] flex-none overflow-hidden rounded-[10px] border border-[var(--app-hairline)] bg-black" style={{ aspectRatio: '16 / 9' }}>
        {playing ? (
          <iframe
            ref={frame}
            key={src}
            src={src}
            title="YouTube video player"
            className="absolute inset-0 h-full w-full border-0"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            // The page's own policy sends no referrer; the player refuses to
            // play without the page's origin (YouTube's errors 152 and 153).
            referrerPolicy="strict-origin-when-cross-origin"
            // No top navigation: the player can never move the window off Caprock.
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[12.5px] text-[#9a9a9a]">
            Paste a link and press Play. Nothing loads from YouTube before that.
          </div>
        )}
        {nudge.latest && (
          <div
            data-watch-nudge
            role="status"
            className="absolute inset-x-3 top-3 flex items-center gap-2 rounded-[8px] border border-[var(--app-hairline-strong)] bg-panel/95 px-3 py-1.5 text-[12.5px] text-fg shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]"
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              {waitLine(nudge.latest)}
              {nudge.more > 0 && <span className="text-fg-faint"> · {nudge.more} more</span>}
            </span>
            <button type="button" onClick={() => go(nudge.latest!.sessionId)} className="shrink-0 rounded-[6px] bg-accent px-2.5 py-0.5 text-[12px] font-medium text-bg">Go</button>
            <button type="button" aria-label="Dismiss" title="Dismiss" onClick={nudge.dismiss} className="shrink-0 px-1 text-fg-faint hover:text-fg">×</button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The newest wait that began since the tab opened and is still waiting, and
 * how many others are. Dismissed, it stays away until another wait begins.
 */
export function useWaitNudge(items: readonly WaitItem[] | undefined, openedAt: number = Date.now()) {
  const opened = useRef(openedAt)
  const seen = useRef(new Set<string>())
  const [shown, setShown] = useState<WaitItem[]>([])
  useEffect(() => {
    if (!items) return
    const fresh = freshWaits(seen.current, items, opened.current)
    for (const w of fresh) seen.current.add(waitKey(w))
    const still = new Set(items.map(waitKey))
    const isFresh = new Set(fresh.map(waitKey))
    setShown((cur) => {
      const next = [...fresh, ...cur.filter((w) => still.has(waitKey(w)) && !isFresh.has(waitKey(w)))]
      return next.length === cur.length && next.every((w, i) => w === cur[i]) ? cur : next
    })
  }, [items])
  const dismiss = useCallback(() => setShown([]), [])
  return { latest: shown[0] ?? null, more: Math.max(0, shown.length - 1), dismiss }
}

/** The browser's waiting list: the live sessions, asked every few seconds. Null until the first answer. */
function useBrowserWaits(on: boolean): WaitItem[] | null {
  const [items, setItems] = useState<WaitItem[] | null>(null)
  useEffect(() => {
    if (!on) return
    let alive = true
    const load = () => api.sessions(true)
      .then((list) => { if (alive) setItems((cur) => sameWaits(cur, waitsOf(list, Date.now()))) })
      .catch(() => { /* the daemon is away: keep what was known */ })
    void load()
    const t = window.setInterval(load, BROWSER_POLL_MS)
    return () => { alive = false; window.clearInterval(t) }
  }, [on])
  return items
}

/** The sessions waiting on the user, as the sidebar counts them (an agent, not stale). */
export function waitsOf(list: readonly SessionSummary[], now: number): WaitItem[] {
  const out: WaitItem[] = []
  for (const s of list) {
    if (!s || s.kind === 'shell' || sessionHealth(s) !== 'waiting-on-you') continue
    const at = s.activity?.at ? Date.parse(s.activity.at) : NaN
    const since = Number.isFinite(at) ? at : s.last_event_at
    if (now - since > STALE_MS) continue
    out.push({ sessionId: s.session_id, title: sessionTitle(s), reason: 'waiting', since })
  }
  return out
}

function sameWaits(cur: WaitItem[] | null, next: WaitItem[]): WaitItem[] {
  if (cur && cur.length === next.length && cur.every((w, i) => waitKey(w) === waitKey(next[i]!) && w.title === next[i]!.title)) return cur
  return next
}
