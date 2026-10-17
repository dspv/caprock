/**
 * The row of quick replies under a session Caprock started (lib/quickReplies.ts):
 * one click sends the reply's text, as the composer would. Nothing at all
 * when the list is empty. A quiet "Reply to the agent:" leads the row and each
 * button's hover names the exact message, so a row of words under a terminal
 * reads as what it is (owner, 2026-10-18, translated: "maybe not very
 * unambiguous").
 */
import { useEffect, useRef, useState } from 'react'
import { errText } from '@/lib/api'
import { forChat, sendQuickReply, useQuickReplies } from '@/lib/quickReplies'

export function QuickReplies({ sessionId, onSend, chat = false, className = '' }: {
  sessionId: string
  /** A chat (ADR-071): the coding defaults are left out (lib/quickReplies forChat). */
  chat?: boolean
  /** The caller's own send (the chat's, which also scrolls and shows the queue); the composer's path by default. */
  onSend?: (text: string) => Promise<unknown>
  className?: string
}) {
  const all = useQuickReplies()
  const items = chat ? forChat(all) : all
  const [state, setState] = useState<{ i: number; phase: 'sending' | 'sent' | 'failed'; error?: string } | null>(null)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  if (items.length === 0) return null

  const send = async (i: number, text: string) => {
    if (state?.phase === 'sending') return
    window.clearTimeout(timer.current)
    setState({ i, phase: 'sending' })
    try {
      const r = onSend ? await onSend(text) : await sendQuickReply(sessionId, text)
      // The chat's send says false when it failed and showed why itself.
      if (r === false) { setState(null); return }
      setState({ i, phase: 'sent' })
    } catch (e) {
      setState({ i, phase: 'failed', error: errText(e) })
    }
    timer.current = window.setTimeout(() => setState(null), 1600)
  }

  return (
    <div role="group" aria-label="Quick replies" data-quick-replies
      className={`flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto px-2 pb-1 pt-1 [scrollbar-width:none] ${className}`}>
      <span aria-hidden data-quick-lead className="shrink-0 pl-1 pr-1 text-[11.5px] text-fg-faint">Reply to the agent:</span>
      {items.map((q, i) => {
        const mine = state?.i === i ? state : null
        return (
          <button
            key={`${i}:${q.label}`}
            type="button"
            data-quick-reply={q.label}
            data-state={mine?.phase}
            disabled={state?.phase === 'sending'}
            // Keep the keyboard where it was: the terminal or the composer.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void send(i, q.text)}
            title={mine?.phase === 'failed' ? `Not sent: ${mine.error}` : `Sends to the agent: “${q.text}”`}
            className="app-quick"
          >
            {mine?.phase === 'sent' && <span aria-hidden className="text-ok">✓</span>}
            {q.label}
          </button>
        )
      })}
      {state?.phase === 'failed' && <span role="alert" className="shrink-0 truncate pl-1 text-[11.5px] text-danger">Not sent: {state.error}</span>}
    </div>
  )
}
