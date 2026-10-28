/**
 * A panel's share sheet (.ai/04-ui.md § Share, "Any panel"): the picture,
 * large, before any button — so the screen shows exactly what goes — the
 * Hide project names tick, and the share card's own block of ways out
 * (ShareActions): Share…, Copy image, Save image, My Telegram, and X,
 * Threads and LinkedIn, which upload this picture to caprock.dev only on
 * their press (ADR-086) and say so in their tooltips and the footer.
 *
 * Loaded only when the menu's *Post to X, Threads or LinkedIn…* is chosen.
 */
import { useEffect, useRef, useState } from 'react'
import { isPairedDevice } from '@/lib/api'
import { panelFileName, panelPostText } from '@/lib/panelShare'
import { ShareActions } from './ShareActions'
import { CloseButton, DialogBackdrop } from './Dialog'

export default function PanelShareSheet({ name, hide, onHide, draw, onClose }: {
  name: string
  hide: boolean
  onHide: (on: boolean) => void
  draw: () => Promise<Blob | null>
  onClose: () => void
}) {
  const [text, setText] = useState(() => panelPostText(name))
  const [preview, setPreview] = useState('')
  const [failed, setFailed] = useState(false)
  // The picture is drawn when the sheet opens and again on the tick; the
  // same drawing then leaves on any button, so what was seen is what goes.
  const blob = useRef<Blob | null>(null)
  const drawRef = useRef(draw)
  useEffect(() => { drawRef.current = draw })

  useEffect(() => {
    let live = true
    drawRef.current().then((b) => {
      if (!live) return
      blob.current = b
      if (!b) { setFailed(true); return }
      setFailed(false)
      const url = URL.createObjectURL(b)
      setPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return url })
    }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [hide])
  const latest = useRef('')
  useEffect(() => { latest.current = preview }, [preview])
  useEffect(() => () => { if (latest.current) URL.revokeObjectURL(latest.current) }, [])

  const uploads = !isPairedDevice()
  return (
    <DialogBackdrop onClose={onClose} className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 px-4 py-[6vh] normal-case tracking-normal"
      role="dialog" aria-modal="true" aria-label={`Share ${name}`}>
      <div data-panel-share-sheet className="w-[760px] max-w-full rounded-[var(--radius-panel)] border border-border-strong bg-panel text-left shadow-[var(--shadow-panel)]" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center border-b border-border py-1.5 pl-4 pr-2">
          <h2 className="text-[13px] font-medium text-fg">Share {name}</h2>
          <CloseButton onClick={onClose} className="ml-auto" />
        </header>
        <div className="px-4 py-4 sm:px-5">
          <div className="mb-4 flex max-h-[56vh] min-h-[120px] items-center justify-center overflow-auto rounded-[10px] border border-border bg-panel-2">
            {failed ? (
              <div className="px-6 py-10 text-center text-[12px] text-fg-faint">Could not draw this panel here.</div>
            ) : preview ? <img src={preview} alt={`${name}, as it will be shared`} className="block h-auto max-w-full" /> : (
              <div className="px-6 py-10 text-center text-[12px] text-fg-faint">Drawing…</div>
            )}
          </div>
          <ShareActions build={async () => blob.current ?? drawRef.current()} fileName={() => panelFileName(name)} text={text} onText={setText}
            disabled={failed || !preview}
            disclosure={
              <div data-share-disclosure className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-panel-2 px-3 py-2 text-[12.5px]">
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-fg">
                  <input type="checkbox" checked={hide} onChange={(e) => onHide(e.target.checked)} data-panel-share-sheet-hide />
                  Hide project names
                </label>
                <span className="text-fg-muted">{hide ? 'Projects, sessions, branches and folders read “project 1”, “session 1”…' : 'The picture shows your project and session names.'}</span>
              </div>
            } />
          <p className="mt-4 border-t border-border pt-3 text-[12.5px] text-fg-muted">
            {uploads
              ? 'Drawn on your machine; only X, Threads and LinkedIn upload it, to caprock.dev.'
              : 'Drawn on your machine, uploaded nowhere.'}
          </p>
        </div>
      </div>
    </DialogBackdrop>
  )
}
