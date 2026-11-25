/**
 * A video a prompt names, shown as a video rather than as its path (owner,
 * 2026-11-25, translated: "I pasted a video into the session and it shows as
 * a path"). Claude Code cannot watch a video, so what reaches the session is
 * still the path; only the chat's bubble changes.
 *
 * The first frame is the poster (`preload="metadata"` and a `#t=0.1`
 * fragment, which WebKit needs before it draws one), the name and the
 * length sit under it, and the native controls play it in place. The bytes
 * come from `GET /v1/events/{id}/video`, which serves a path only to the
 * prompt that names it, with ranges. A file that is gone, a path the daemon
 * refuses or a codec the webview cannot play falls back to the path as
 * written.
 */
import { useState } from 'react'
import { isPairedDevice } from '@/lib/api'
import { baseName } from '@/lib/attach'
import { fmtElapsed } from '@/lib/chatActivity'

/**
 * Whether this page can show a video tile: on the machine itself. A paired
 * device's <video> cannot carry its token, and the phone's page reaches the
 * daemon through the relay, so both keep the path.
 */
export function videoTiles(): boolean {
  return import.meta.env.VITE_CAPROCK_REMOTE !== '1' && !isPairedDevice()
}

/** Where the tile's <video> reads the file. */
export function videoSrc(eventId: number, path: string): string {
  return `/v1/events/${eventId}/video?path=${encodeURIComponent(path)}`
}

export function VideoTile({ eventId, path, raw }: { eventId: number; path: string; raw: string }) {
  const [failed, setFailed] = useState(false)
  const [secs, setSecs] = useState<number | null>(null)
  if (failed) return <span data-video-fallback>{raw}</span>
  return (
    <figure data-video-tile className="m-0 w-[320px] min-w-0 max-w-full overflow-hidden rounded-[8px] border border-border bg-bg/60">
      <video
        src={`${videoSrc(eventId, path)}#t=0.1`}
        controls
        preload="metadata"
        playsInline
        title={path}
        aria-label={baseName(path)}
        className="block max-h-[240px] w-full bg-black"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration
          setSecs(Number.isFinite(d) ? d : null)
        }}
        onError={() => setFailed(true)}
      />
      <figcaption className="flex min-w-0 items-center gap-1.5 whitespace-nowrap px-2.5 py-1 text-[11.5px] leading-snug text-fg-faint">
        <span className="min-w-0 truncate">{baseName(path)}</span>
        {secs !== null && <span className="mono shrink-0">· {fmtElapsed(secs * 1000)}</span>}
      </figcaption>
    </figure>
  )
}
