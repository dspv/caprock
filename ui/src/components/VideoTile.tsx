/**
 * A video a prompt names, shown as a video rather than as its path (owner,
 * 2026-11-25, translated: "I pasted a video into the session and it shows as
 * a path"). Claude Code cannot watch a video, so what reaches the session is
 * still the path; only the chat's bubble changes.
 *
 * Only a picture of it (owner's pick, variant A): the first frame, the name
 * and the length, and a click opens the file in the system's own player
 * (`POST /v1/events/{id}/video/open`). Nothing plays here. The <video> is
 * there for the frame alone: muted, no controls, no autoplay, never
 * focusable or clickable itself, `preload="metadata"` and a `#t=0.1`
 * fragment (WebKit draws no frame without one), read from
 * `GET /v1/events/{id}/video` a megabyte at a time. Once the first frame is
 * in it is kept as a picture and the <video> lets go of the file (stillOf),
 * so the first megabytes are read and never the whole file. A file that is gone, a path the daemon
 * refuses or a codec the webview cannot decode falls back to the path as
 * written.
 */
import { useState } from 'react'
import { api, errText, isPairedDevice } from '@/lib/api'
import { baseName } from '@/lib/attach'
import { fmtElapsed } from '@/lib/chatActivity'

/**
 * Whether this page can show a video tile: on the machine itself. A paired
 * device's <video> cannot carry its token, the phone's page reaches the
 * daemon through the relay, and the player would open on the machine, not
 * in the hand: both keep the path.
 */
export function videoTiles(): boolean {
  return import.meta.env.VITE_CAPROCK_REMOTE !== '1' && !isPairedDevice()
}

/** Where the tile's <video> reads the file. */
export function videoSrc(eventId: number, path: string): string {
  return `/v1/events/${eventId}/video?path=${encodeURIComponent(path)}`
}

/**
 * The frame on screen as a JPEG, and the element let go of its file. WebKit
 * goes on reading the whole file after the first frame whatever `preload`
 * says (all 34 MB of a test recording, 2026-11-25), so once the frame is
 * there it is kept as a picture and the <video> drops its source, which
 * stops the reading. '' when the frame cannot be drawn: the <video> stays.
 */
export function stillOf(v: HTMLVideoElement): string {
  const w = v.videoWidth
  const h = v.videoHeight
  if (!w || !h) return ''
  try {
    const scale = Math.min(1, 640 / w)
    const c = document.createElement('canvas')
    c.width = Math.round(w * scale)
    c.height = Math.round(h * scale)
    const g = c.getContext('2d')
    if (!g) return ''
    g.drawImage(v, 0, 0, c.width, c.height)
    const url = c.toDataURL('image/jpeg', 0.85)
    if (!url.startsWith('data:image/')) return ''
    v.removeAttribute('src')
    v.load()
    return url
  } catch {
    return ''
  }
}

export function VideoTile({ eventId, path, raw }: { eventId: number; path: string; raw: string }) {
  const [failed, setFailed] = useState(false)
  const [secs, setSecs] = useState<number | null>(null)
  const [openError, setOpenError] = useState('')
  const [frame, setFrame] = useState('')
  if (failed) return <span data-video-fallback>{raw}</span>
  const name = baseName(path)
  return (
    <button
      type="button"
      data-video-tile
      title={openError ? `${path}\n${openError}` : `Open in the default player — ${path}`}
      aria-label={`Open ${name} in the default player`}
      onClick={() => {
        setOpenError('')
        api.openVideo(eventId, path).catch((e: unknown) => setOpenError(errText(e)))
      }}
      className="block w-[320px] min-w-0 max-w-full cursor-pointer overflow-hidden rounded-[8px] border border-border bg-bg/60 p-0 text-left hover:border-fg-faint"
    >
      {frame ? (
        <img src={frame} alt="" aria-hidden className="pointer-events-none block max-h-[240px] w-full bg-black object-contain" />
      ) : (
        <video
          src={`${videoSrc(eventId, path)}#t=0.1`}
          preload="metadata"
          muted
          playsInline
          disablePictureInPicture
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none block max-h-[240px] w-full bg-black"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration
            setSecs(Number.isFinite(d) ? d : null)
          }}
          onLoadedData={(e) => {
            const still = stillOf(e.currentTarget)
            if (still) setFrame(still)
          }}
          // Not after stillOf let the file go on purpose.
          onError={(e) => { if (e.currentTarget.hasAttribute('src')) setFailed(true) }}
        />
      )}
      <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap px-2.5 py-1 text-[11.5px] leading-snug text-fg-faint">
        <span className="min-w-0 truncate">{name}</span>
        {secs !== null && <span className="mono shrink-0">· {fmtElapsed(secs * 1000)}</span>}
      </span>
      {openError && <span role="alert" className="block px-2.5 pb-1 text-[11.5px] text-danger">{openError}</span>}
    </button>
  )
}
