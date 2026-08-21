/**
 * The feedback button: a few words in, a filed issue out.
 *
 * Two clicks and a sentence is the whole interaction — pick what kind of thing
 * it is, type what you saw, press the button. The context a maintainer would
 * otherwise have to ask for (version, platform, scale, which screen) is
 * gathered and *shown* before anything happens.
 *
 * Nothing is transmitted from here. The button opens a prefilled GitHub issue
 * in a new tab; the user reads it, edits it, and submits it. That is what keeps
 * this compatible with the promise the product is bought on — and it is also
 * why the panel says so out loud rather than making anyone wonder.
 */
import { useState } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { context, isSendable, issueURL, KINDS, type FeedbackKind } from '@/lib/feedback'

export function FeedbackButton({ screen }: { screen: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-[11px] text-fg-muted hover:text-fg border border-border px-1.5 py-0.5 rounded-sm"
        title="Report a bug, ask for something, or say what was unclear"
      >
        feedback
      </button>
      {open && <FeedbackDialog screen={screen} onClose={() => setOpen(false)} />}
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
    window.open(issueURL(kind, screen, text, ctx), '_blank', 'noopener')
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-30 bg-black/50 flex items-start justify-center pt-[12vh] px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[520px] border border-border-strong bg-panel rounded-[var(--radius-panel)] shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-3 pb-2 border-b border-border flex items-center">
          <span className="text-[13px] font-medium">Tell us what happened</span>
          <button onClick={onClose} className="ml-auto text-[16px] leading-none text-fg-faint hover:text-fg">
            ×
          </button>
        </div>

        <div className="p-4 grid gap-3">
          <div className="flex gap-1.5">
            {KINDS.map((k) => (
              <button
                key={k.id}
                onClick={() => setKind(k.id)}
                className={`text-[12px] px-2.5 py-1 rounded-sm border ${
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
            rows={4}
            className="input w-full resize-y text-[13px] leading-relaxed"
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
            <span className="text-[11px] text-fg-faint">
              {ready ? '⌘↵ to open' : 'a sentence is enough'}
            </span>
          </div>

          <p className="text-[11px] text-fg-faint leading-relaxed">
            Nothing is sent from here. The issue opens in your browser with the text above
            filled in — read it, change it, and submit it yourself.
          </p>
        </div>
      </div>
    </div>
  )
}
