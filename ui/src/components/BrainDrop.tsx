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
import { BRAIN_PATH } from './SettingsIcons'

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

/** Second Brain's mark: a brain in outline (the owner, 2026-10-14: the drop
 *  falling into a bowl it replaced did not read as a brain). Beside its name
 *  wherever the name is shown — the sidebar block, the screen row, the
 *  screen's title, ⌘K — and on every way in. The path is Settings → Second
 *  Brain's icon (components/SettingsIcons), so the two are one drawing. */
export function BrainGlyph({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d={BRAIN_PATH} />
    </svg>
  )
}
