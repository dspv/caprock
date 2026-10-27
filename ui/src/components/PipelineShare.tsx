/**
 * Share the Pipeline's figures (.ai/04-ui.md § Share, "The Pipeline card"):
 * a Share button in the page's head opens a sheet with the card — the eight
 * Flow figures with their lines, the window and caprock.dev — and the ways
 * out (ShareActions).
 *
 * Anonymous by default: the card and the words say "a GitHub repo"
 * (PipelineShareCard.ts). Show repo name is unticked every time the sheet
 * opens and never remembered; the line above the buttons says what the card
 * names, so the choice is made looking at it.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PRBoard } from '@/lib/prboard'
import { screenLook, type CardLook } from './ShareCard'
import { drawPipelineCard, pipelineCardData, pipelineFilename, pipelinePostText, repoLabel } from './PipelineShareCard'
import { ShareActions } from './ShareActions'
import { CloseButton, DialogBackdrop } from './Dialog'

export function PipelineShareButton({ board, repo }: { board: PRBoard; repo?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" data-pipeline-share onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/15 px-2.5 py-[3px] text-[12px] font-medium text-accent transition-colors hover:bg-accent/25"
        title="Draw a picture of these figures to save, copy, post or send">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
          <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
        </svg>
        Share
      </button>
      {open && <PipelineShareDialog board={board} repo={repo} onClose={() => setOpen(false)} />}
    </>
  )
}

export function PipelineShareDialog({ board, repo, onClose }: { board: PRBoard; repo?: string; onClose: () => void }) {
  // Unticked on every open, never stored: a private name must not leak by habit.
  const [show, setShow] = useState(false)
  const [look, setLook] = useState<CardLook>(screenLook)
  const takenAt = useRef(new Date()).current
  const data = useMemo(() => pipelineCardData(board, repo, show, takenAt), [board, repo, show, takenAt])
  const [text, setText] = useState(() => pipelinePostText(pipelineCardData(board, repo, false, takenAt)))
  const [preview, setPreview] = useState('')
  const [failed, setFailed] = useState(false)

  // The name toggled: the words follow, wherever the person put it.
  const toggle = (on: boolean) => {
    const from = repoLabel(repo, show)
    const to = repoLabel(repo, on)
    setShow(on)
    if (from !== to) setText((t) => t.split(from).join(to))
  }

  useEffect(() => {
    let live = true
    drawPipelineCard(data, look).then((b) => {
      if (!live) return
      if (!b) { setFailed(true); return }
      setFailed(false)
      const url = URL.createObjectURL(b)
      setPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return url })
    }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [data, look])
  const latest = useRef('')
  latest.current = preview
  useEffect(() => () => { if (latest.current) URL.revokeObjectURL(latest.current) }, [])

  const seg = (on: boolean) => `rounded-[5px] px-2.5 py-1 text-[12px] transition-colors ${on ? 'bg-panel text-fg font-medium shadow-sm' : 'text-fg-muted hover:text-fg'}`

  return (
    <DialogBackdrop onClose={onClose} className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/55 px-4 py-[6vh]"
      role="dialog" aria-modal="true" aria-label="Share the Pipeline's figures">
      <div data-pipeline-share-sheet className="w-[760px] max-w-full rounded-[var(--radius-panel)] border border-border-strong bg-panel shadow-[var(--shadow-panel)]" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center border-b border-border py-1.5 pl-4 pr-2">
          <h2 className="text-[13px] font-medium text-fg">Share the Pipeline’s figures</h2>
          <CloseButton onClick={onClose} className="ml-auto" />
        </header>
        <div className="px-4 py-4 sm:px-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-fg-muted">Last {board.flow.days} days · read from GitHub</span>
            <div className="ml-auto inline-flex items-center gap-0.5 rounded-md border border-border bg-panel-2 p-0.5" role="group" aria-label="Card look">
              {(['dark', 'paper'] as CardLook[]).map((l) => (
                <button key={l} onClick={() => setLook(l)} aria-pressed={look === l} className={seg(look === l)}>{l === 'dark' ? 'Dark' : 'Light'}</button>
              ))}
            </div>
          </div>
          <div className="mb-4 overflow-hidden rounded-[10px] border border-border bg-panel-2 shadow-[var(--shadow-panel)]" style={{ aspectRatio: '1200 / 630' }}>
            {failed ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-fg-faint">Could not draw the card here.</div>
            ) : preview ? <img src={preview} alt="The Pipeline's figures, as they will be shared" className="block w-full" /> : null}
          </div>
          <ShareActions build={() => drawPipelineCard(data, look)} fileName={() => pipelineFilename(data)} text={text} onText={setText}
            disabled={failed}
            disclosure={
              <div data-share-disclosure className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-panel-2 px-3 py-2 text-[12.5px]">
                <span className="text-fg-muted">The card names <b className="font-medium text-fg">{repoLabel(repo, show)}</b></span>
                {repo && (
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-fg">
                    <input type="checkbox" checked={show} onChange={(e) => toggle(e.target.checked)} data-share-show-repo />
                    Show repo name <span className="mono text-fg-muted">({repo})</span>
                  </label>
                )}
              </div>
            } />
          <ul className="mt-4 grid gap-1 border-t border-border pt-3 text-[12.5px] text-fg-muted">
            <li>Aggregate figures only — no pull request titles, branches, authors or paths.</li>
            <li>Drawn on your machine. Nothing leaves until you press a button; X, Threads and LinkedIn upload the picture to caprock.dev.</li>
            <li>A 2400×1260 PNG · agent cost at API list price — not a bill.</li>
          </ul>
        </div>
      </div>
    </DialogBackdrop>
  )
}
