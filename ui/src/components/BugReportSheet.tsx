/**
 * Report a bug (ADR-073): a bottom sheet on a phone, a dialog on a computer.
 *
 * The owner, 2026-10-17 (translated): a bug report the user can type or
 * dictate with the phone keyboard, attach a few screenshots, and send to
 * Caprock support — not a GitHub issue, because it may contain personal data;
 * an optional email so we can reply.
 *
 * Top to bottom: *What happened?* (typed, or dictated with the keyboard's own
 * mic), up to three screenshots shown as thumbnails with a × each, *Email for
 * a reply (optional)*, then — before the button, as rule 4 asks — the line
 * that names every field that leaves the machine and where it goes. Nothing
 * is sent until **Send to support**; the daemon adds the version and the OS
 * (internal/api/support.go) and nothing else.
 *
 * Opened from ⌘K *Report a bug…*; the phone chat bar's + menu went with
 * that bar (owner, 2026-10-21). The form is kept while the sheet is closed
 * with Cancel, and cleared once a report is sent. The thank-you toast outlives the sheet, so the
 * component renders it after `open` turns false.
 */
import { useEffect, useId, useRef, useState, type ChangeEvent, type JSX } from 'react'
import { errText } from '@/lib/api'
import { SUPPORT_LIMITS, prepareShot, reportProblem, sendReport, type SupportShot } from '@/lib/support'
import { DialogBackdrop } from './Dialog'

export const BUG_PRIVACY_LEAD = 'Sent to Caprock support (caprock.dev), not GitHub:'
export const BUG_PRIVACY_REST = 'your text, the screenshots you attached, your email if given, Caprock version and OS. Nothing else — no transcripts, no logs.'
export const BUG_SENT = 'Sent. Thank you — we reply by email if you left one.'

type Shot = SupportShot & { id: number }

let nextShot = 1

export function BugReportSheet(props: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { open, onClose } = props
  const [text, setText] = useState('')
  const [email, setEmail] = useState('')
  const [shots, setShots] = useState<Shot[]>([])
  const [problem, setProblem] = useState('')
  const [sending, setSending] = useState(false)
  const [toast, setToast] = useState('')
  const textRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const uid = useId()

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(''), 6000)
    return () => window.clearTimeout(id)
  }, [toast])

  // Focus the text on open, so the keyboard (and its mic) is up at once.
  useEffect(() => {
    if (open) {
      setProblem('')
      textRef.current?.focus()
    }
  }, [open])

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    const room = SUPPORT_LIMITS.shots - shots.length
    const notes: string[] = []
    if (files.length > room) notes.push(`At most ${SUPPORT_LIMITS.shots} screenshots: ${files.length - room} left out.`)
    const added: Shot[] = []
    for (const f of files.slice(0, Math.max(0, room))) {
      try {
        added.push({ ...(await prepareShot(f)), id: nextShot++ })
      } catch (err) {
        notes.push(errText(err))
      }
    }
    if (added.length) setShots((s) => [...s, ...added].slice(0, SUPPORT_LIMITS.shots))
    setProblem(notes.join(' '))
  }

  const send = async () => {
    if (sending) return
    const report = { text, email, screenshots: shots.map(({ name, type, data }) => ({ name, type, data })) }
    const why = reportProblem(report)
    if (why) {
      setProblem(why)
      if (!text.trim()) textRef.current?.focus()
      return
    }
    setSending(true)
    setProblem('')
    try {
      await sendReport(report)
      setText('')
      setEmail('')
      setShots([])
      setToast(BUG_SENT)
      onClose()
    } catch (err) {
      setProblem(`Not sent: ${errText(err)}. Your report is kept — try again.`)
    } finally {
      setSending(false)
    }
  }

  const toastEl = toast ? (
    <div role="status" className="app-fade-in pointer-events-none fixed inset-x-0 bottom-[max(2.5rem,env(safe-area-inset-bottom))] z-[60] flex justify-center px-4">
      <p className="pointer-events-auto max-w-[560px] rounded-[10px] border border-border-strong bg-panel px-4 py-2.5 text-[13px] text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]">{toast}</p>
    </div>
  ) : null

  if (!open) return toastEl

  const field = 'w-full rounded-[10px] border border-border-strong bg-bg px-3 text-[16px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none sm:text-[14px]'
  return (
    <>
      {toastEl}
      <DialogBackdrop
        onClose={() => { if (!sending) onClose() }}
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-start sm:px-4 sm:pt-[10vh]"
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Report a bug"
          data-bug-report
          className="app-fade-in max-h-[92dvh] w-full overflow-y-auto overflow-x-hidden rounded-t-[18px] border-t border-border-strong bg-panel px-4 pb-[max(1.1rem,env(safe-area-inset-bottom))] pt-2 shadow-[0_-10px_30px_-16px_rgba(0,0,0,0.4)] sm:max-w-[480px] sm:rounded-[12px] sm:border sm:px-5 sm:pb-5 sm:pt-4 sm:shadow-[0_24px_64px_-20px_rgba(0,0,0,0.55)]"
        >
          <div aria-hidden className="mx-auto mb-2.5 h-[5px] w-9 rounded-full bg-border-strong sm:hidden" />
          <h2 className="mb-3 mt-0.5 text-[18px] font-semibold text-fg sm:text-[16px]">Report a bug</h2>

          <div className="mb-3">
            <label htmlFor={`${uid}-text`} className="mb-1.5 block text-[13px] font-medium text-fg-muted">What happened?</label>
            <textarea
              ref={textRef}
              id={`${uid}-text`}
              rows={4}
              value={text}
              aria-describedby={`${uid}-hint`}
              onChange={(e) => { setText(e.target.value); if (problem) setProblem('') }}
              className={`${field} min-h-[96px] resize-none py-2.5 leading-[1.4]`}
            />
            <span id={`${uid}-hint`} className="mt-1 block text-[12px] text-fg-faint">Type, or tap the mic on your keyboard to dictate</span>
          </div>

          <div className="mb-3.5 flex flex-wrap gap-2.5" aria-label="Screenshots">
            {shots.map((s) => (
              <div key={s.id} className="relative h-[72px] w-[56px] rounded-[8px] border border-border-strong bg-panel-2">
                <img src={`data:${s.type};base64,${s.data}`} alt={s.name} className="h-full w-full rounded-[8px] object-cover" />
                <button
                  type="button"
                  aria-label={`Remove screenshot ${s.name}`}
                  onClick={() => setShots((all) => all.filter((x) => x.id !== s.id))}
                  className="absolute -right-[7px] -top-[7px] grid h-6 w-6 place-items-center rounded-full bg-fg text-[15px] leading-none text-bg"
                >
                  ×
                </button>
              </div>
            ))}
            {shots.length < SUPPORT_LIMITS.shots && (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="h-[72px] rounded-[8px] border border-dashed border-border-strong px-3 text-[13.5px] font-medium text-accent"
              >
                + Add screenshot
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/*" multiple hidden aria-label="Add screenshot" onChange={(e) => void onPick(e)} />
          </div>

          <label className="mb-3 block">
            <span className="mb-1.5 block text-[13px] font-medium text-fg-muted">Email for a reply (optional)</span>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              maxLength={254}
              onChange={(e) => setEmail(e.target.value)}
              className={`${field} h-11`}
            />
          </label>

          <p data-bug-privacy className="mb-3.5 mt-0.5 rounded-r-[8px] border-l-[3px] border-accent bg-panel-2 px-3 py-2.5 text-[13px] leading-[1.45] text-fg-muted">
            <b className="font-semibold text-fg">{BUG_PRIVACY_LEAD}</b> {BUG_PRIVACY_REST}
          </p>

          {problem && <p role="alert" className="mb-3 text-[13px] text-danger">{problem}</p>}

          <div className="grid grid-cols-[1fr_1.5fr] gap-2">
            <button type="button" onClick={onClose} disabled={sending} className="h-[46px] rounded-[10px] border border-border-strong text-[15px] font-medium text-fg disabled:opacity-50 sm:h-[38px] sm:text-[14px]">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending}
              aria-busy={sending}
              className="h-[46px] rounded-[10px] bg-accent text-[15px] font-medium text-panel hover:brightness-110 disabled:opacity-50 sm:h-[38px] sm:text-[14px]"
            >
              Send to support
            </button>
          </div>
        </div>
      </DialogBackdrop>
    </>
  )
}
