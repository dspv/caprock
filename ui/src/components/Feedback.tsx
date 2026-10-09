/**
 * The feedback button: a few words in, a filed issue out.
 *
 * Two clicks and a sentence is the whole interaction — pick what kind of thing
 * it is, type what you saw, press the button. The context a maintainer would
 * otherwise have to ask for (version, platform, scale, which screen) is
 * gathered and *shown* before anything happens.
 *
 * Nothing is transmitted from here. The button opens a prefilled GitHub issue
 * in the browser; the user reads it, edits it, and submits it. That is what
 * keeps this compatible with the promise the product is bought on — and it is
 * also why the panel says so out loud rather than making anyone wonder.
 *
 * **Where it is.** It was an 11px grey word, "feedback", among the header's
 * chips, and the owner never noticed it was there (2026-10-10). It is now a
 * labelled button with a megaphone in the dashboard's header, and in the
 * desktop app also an icon beside Settings in the sidebar's bottom bar, which
 * is on screen whatever tab is in front.
 *
 * **How the issue opens.** Through `openExternal` (lib/nudges.ts): the desktop
 * app's `open_external` command, which hands the URL to the default browser,
 * and `window.open` in a browser tab. A bare `window.open` inside the app's
 * webview only reached the browser by way of the shell's new-window handler.
 */
import { useState } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { openExternal } from '@/lib/nudges'
import { isAppMode } from '@/lib/appmode'
import { context, currentScreen, isSendable, issueURL, KINDS, type FeedbackKind } from '@/lib/feedback'
import { FeedbackIcon } from './AppIcons'
import { CloseButton, DialogBackdrop } from './Dialog'

const TIP = 'Report a bug, ask for something, or say what was unclear'

/**
 * `header`: the labelled button in the dashboard's header. `icon`: a 26px
 * icon button for the app sidebar's bottom bar. `screen` names where the
 * report comes from; without it, the screen in front when the dialog opens.
 */
export function FeedbackButton({ screen, variant = 'header' }: { screen?: string; variant?: 'header' | 'icon' }) {
  const [open, setOpen] = useState<string | null>(null)
  const show = () => setOpen(screen ?? currentScreen(location.hash, isAppMode()))
  return (
    <>
      {variant === 'icon' ? (
        <button
          type="button"
          onClick={show}
          title={`Feedback: ${TIP.toLowerCase()}`}
          aria-label="Send feedback"
          className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-fg-muted transition-colors hover:bg-[var(--app-row-hover)] hover:text-fg motion-reduce:transition-none"
        >
          <FeedbackIcon size={15} />
        </button>
      ) : (
        <button
          type="button"
          onClick={show}
          title={TIP}
          className="inline-flex h-[24px] items-center gap-1.5 rounded-[6px] border border-border-strong px-2 text-[12px] font-medium text-fg transition-colors hover:border-accent/60 hover:text-accent motion-reduce:transition-none"
        >
          <FeedbackIcon size={13} />
          Feedback
        </button>
      )}
      {open !== null && <FeedbackDialog screen={open} onClose={() => setOpen(null)} />}
    </>
  )
}

function FeedbackDialog({ screen, onClose }: { screen: string; onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>('bug')
  const [text, setText] = useState('')
  const status = useApi(() => api.status(), [], { live: false, intervalMs: 0 })
  const ctx = context(status.data, screen)
  const ready = isSendable(text)
  const active = KINDS.find((k) => k.id === kind) ?? KINDS[0]!

  const send = () => {
    if (!ready) return
    openExternal(issueURL(kind, screen, text, ctx))
    onClose()
  }

  return (
    <DialogBackdrop
      onClose={onClose}
      className="fixed inset-0 z-30 bg-black/50 flex items-start justify-center pt-[12vh] px-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Feedback"
        className="w-full max-w-[660px] border border-border-strong bg-panel rounded-[var(--radius-panel)] shadow-lg"
      >
        <div className="pl-4 pr-2 py-1.5 border-b border-border flex items-center">
          <span className="text-[15px] font-medium">Tell us what happened</span>
          <CloseButton onClick={onClose} className="ml-auto" />
        </div>

        <div className="p-4 grid gap-3">
          <div className="flex gap-1.5">
            {KINDS.map((k) => (
              <button
                key={k.id}
                onClick={() => setKind(k.id)}
                className={`text-[13px] px-3.5 py-1.5 rounded-sm border font-mono ${
                  k.id === kind
                    ? 'border-accent/60 bg-accent/10 text-accent'
                    : 'border-border text-fg-muted hover:text-fg'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>

          {/* Autofocused: the fewer deliberate actions between "I noticed
            * something" and typing it, the more reports actually get written. */}
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={active.hint}
            rows={6}
            className="input w-full resize-y text-[14px] leading-relaxed"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send()
            }}
          />

          {/* Shown, not implied: whatever is attached is on screen before the
            * user commits to anything. */}
          <div className="border border-border rounded-sm bg-panel-2/50 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.12em] text-fg-faint mb-1">Attached</div>
            <ul className="text-[11px] text-fg-muted num grid gap-0.5">
              {ctx.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={send}
              disabled={!ready}
              className={`text-[12px] px-3 py-1.5 rounded-sm border ${
                ready
                  ? 'border-accent/50 bg-accent/10 text-accent hover:bg-accent/20'
                  : 'border-border text-fg-faint cursor-not-allowed'
              }`}
            >
              Open a GitHub issue →
            </button>
            {/* Louder than the note below it: this is the line that decides
              * whether someone types at all, and in the same faint grey as the
              * disclaimer it read as fine print. */}
            <span className={`text-[12px] ${ready ? 'text-fg-faint' : 'text-fg-muted'}`}>
              {ready ? '⌘↵ to open' : 'One sentence is enough.'}
            </span>
          </div>

          <p className="text-[11px] text-fg-faint leading-relaxed">
            Nothing is sent from here — the issue opens prefilled in your browser
            for you to submit.
          </p>
        </div>
      </div>
    </DialogBackdrop>
  )
}
