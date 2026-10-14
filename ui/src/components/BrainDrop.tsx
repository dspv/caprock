/**
 * "Drop into Second Brain" on an answer Claude wrote (ADR-063): the Memory screen's
 * rows, a session's Notes tab and the chat view. The daemon reads the note's
 * text, session, time and project from the record itself by its event id, so
 * the button carries nothing but the id.
 *
 * Writing the brain is the machine's: a paired device sees no button.
 */
import { useState } from 'react'
import { isPairedDevice } from '@/lib/api'
import { dropIntoBrain } from '@/lib/brain'

type State = { at: 'idle' } | { at: 'busy' } | { at: 'done' } | { at: 'error'; message: string }

export function BrainDropButton({ eventId, className = '' }: { eventId: number; className?: string }) {
  const [st, setSt] = useState<State>({ at: 'idle' })
  if (isPairedDevice()) return null
  const drop = async () => {
    if (st.at === 'busy' || st.at === 'done') return
    setSt({ at: 'busy' })
    const r = await dropIntoBrain({ event_id: eventId })
    if (r.ok) setSt({ at: 'done' })
    else setSt({ at: 'error', message: r.message })
  }
  const label = st.at === 'done' ? 'In Second Brain' : st.at === 'busy' ? 'Dropping…' : 'Drop into Second Brain'
  return (
    <>
      <button
        type="button"
        data-brain-drop
        onClick={() => void drop()}
        disabled={st.at === 'busy'}
        aria-label={label}
        title={st.at === 'error' ? st.message : st.at === 'done' ? 'Kept in Second Brain' : 'Keep this answer in Second Brain'}
        className={`inline-flex items-center gap-1 rounded-sm px-1 text-[11px] ${
          st.at === 'done' ? 'text-ok' : st.at === 'error' ? 'text-danger' : 'text-fg-faint hover:text-accent'
        } ${className}`}
      >
        <BrainGlyph size={12} />
        <span>{st.at === 'error' ? 'Could not drop' : label}</span>
      </button>
    </>
  )
}

/** Second Brain's mark: a drop falling into a shallow bowl, the Pensieve.
 *  Beside its name wherever the name is shown — the sidebar block, the
 *  screen row, the screen's title, ⌘K — and on every way in. */
export function BrainGlyph({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path d="M8 1.8c1.3 1.7 2 2.8 2 3.7a2 2 0 0 1-4 0c0-.9.7-2 2-3.7z" fill="currentColor" />
      <path d="M2.2 9.5h11.6c-.4 2.6-2.8 4.5-5.8 4.5s-5.4-1.9-5.8-4.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}
