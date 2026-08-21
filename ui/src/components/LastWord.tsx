/**
 * What Claude said last, without switching to the terminal.
 *
 * The question this answers is the one that sends people back to their terminal
 * dozens of times a day: a session is waiting, and you cannot tell what for
 * without going to look. The text is already here — the daemon stores every
 * assistant turn — so the switch was never necessary, only unavailable.
 *
 * It shows rather than acts. Typing into a session Caprock did not spawn is
 * refused by rule 7, and that rule is worth more than the convenience: writing
 * blind into someone's terminal is how you interrupt work you cannot see.
 * Reading has no such cost, so this works for every session, including the ones
 * started by hand — which is nearly all of them.
 */
import { useEffect, useState } from 'react'
import { api, type AssistantNote, type SessionSummary } from '@/lib/api'
import { fmtAgo } from '@/lib/format'
import { href } from '@/lib/router'

export function LastWord({ session, now, onClose }: {
  session: SessionSummary
  now: number
  onClose: () => void
}) {
  const [notes, setNotes] = useState<AssistantNote[] | null>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const got = await api.notes(session.session_id, 12)
        if (!cancelled) setNotes(got)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'could not load')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [session.session_id])

  // The newest complete thought, not merely the newest text. Roughly a third of
  // sessions end mid-sentence ("Let me check that…"), and showing that as the
  // answer would be worse than showing nothing.
  const conclusion = notes?.find((n) => !n.fragment)
  const newest = notes?.[0]
  const shown = conclusion ?? newest

  return (
    <div className="fixed inset-0 z-30 bg-black/50 flex items-start justify-center pt-[10vh] px-4" onClick={onClose}>
      <div
        className="w-full max-w-[720px] max-h-[76vh] flex flex-col border border-border-strong bg-panel rounded-[var(--radius-panel)] shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-3 pb-2 border-b border-border flex items-baseline gap-2">
          <span className="text-[13px] font-medium truncate">{session.project || 'unknown project'}</span>
          <span className="text-[11px] text-fg-muted truncate">{session.activity?.phrase}</span>
          <button onClick={onClose} className="ml-auto text-[16px] leading-none text-fg-faint hover:text-fg">
            ×
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-3 grid gap-3">
          {!notes && !error && <div className="text-[12px] text-fg-muted">loading…</div>}
          {error && <div className="text-[12px] text-danger">{error}</div>}

          {notes && !shown && (
            <div className="text-[12px] text-fg-muted">
              This session has not said anything yet — it may be running without hooks, or still
              on its first turn.
            </div>
          )}

          {shown && (
            <>
              <div className="text-[10px] uppercase tracking-[0.12em] text-fg-faint">
                Last thing Claude said · {fmtAgo(shown.ts, now)}
                {conclusion && newest && conclusion.event_id !== newest.event_id && (
                  <span className="ml-2 normal-case tracking-normal text-fg-muted">
                    (the newest line was mid-thought; this is the last complete one)
                  </span>
                )}
              </div>
              {/* Whitespace preserved: Claude writes in paragraphs and lists,
                * and reflowing them makes a plan unreadable. */}
              <div className="text-[13px] leading-relaxed whitespace-pre-wrap text-fg">{shown.text}</div>
            </>
          )}

          {session.activity?.plan && session.activity.plan.total > 0 && (
            <div className="border-t border-border pt-3">
              <div className="text-[10px] uppercase tracking-[0.12em] text-fg-faint mb-1">
                Plan · {session.activity.plan.done}/{session.activity.plan.total}
              </div>
              {session.activity.plan.next && (
                <div className="text-[12px] text-fg-muted">→ {session.activity.plan.next}</div>
              )}
            </div>
          )}
        </div>

        <div className="px-4 py-2 border-t border-border flex items-center gap-3 text-[11px]">
          <a href={href({ name: 'session', id: session.session_id })} className="link text-fg-muted hover:text-fg">
            open the session →
          </a>
          {/* Said plainly rather than left as a missing button: a session
            * Caprock did not start cannot be typed into (rule 7). */}
          <span className="ml-auto text-fg-faint">
            {session.owned ? 'answer in its terminal tab' : 'reply in the terminal you started it in'}
          </span>
        </div>
      </div>
    </div>
  )
}
