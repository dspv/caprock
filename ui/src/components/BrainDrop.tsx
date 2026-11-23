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
  const label = st.at === 'done' ? 'In 2nd Brain' : st.at === 'busy' ? 'Dropping…' : 'Drop into 2nd Brain'
  return (
    <>
      <button
        type="button"
        data-brain-drop
        onClick={() => void drop()}
        disabled={st.at === 'busy'}
        aria-label={label}
        title={st.at === 'error' ? st.message : st.at === 'done' ? 'Kept in 2nd Brain' : 'Keep this answer in 2nd Brain'}
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

/**
 * 2nd Brain's mark: a small brain made of dots and links — BrainMark (the
 * *How it works* picture) drawn small enough to sit beside a name (owner,
 * 2026-11-23: the outline before it read as an "i" at sidebar size). The
 * dots wear the four memory kinds' colours (`--brain-idea`, `-decision`,
 * `-finding`, `-question`; tokens.css), the links the text colour, so it
 * follows every palette. Beside the name wherever the name is shown — the
 * sidebar card and its folded row, the nav, the screen's title, ⌘K — and
 * on every way in. Laid out to read at 14px: twelve dots, the two in the
 * middle a little bigger.
 */
const GLYPH_NODES: [number, number][] = [[6, 13], [9, 8], [14, 6], [19, 7], [23, 10], [24, 15], [21, 19], [16, 20], [11, 19], [13, 13], [18, 13], [17, 23]]
const GLYPH_LINKS: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 0], [1, 9], [9, 10], [10, 4], [9, 8], [10, 6], [7, 11]]
const GLYPH_KINDS = ['var(--brain-idea)', 'var(--brain-decision)', 'var(--brain-finding)', 'var(--brain-question)']

export function BrainGlyph({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="3.5 3.5 23 22" fill="none" aria-hidden className={className} data-brain-glyph-mark>
      <g stroke="currentColor" strokeOpacity={0.55} strokeWidth={1.3} strokeLinecap="round">
        {GLYPH_LINKS.map(([a, b]) => (
          <line key={`${a}-${b}`} x1={GLYPH_NODES[a]![0]} y1={GLYPH_NODES[a]![1]} x2={GLYPH_NODES[b]![0]} y2={GLYPH_NODES[b]![1]} />
        ))}
      </g>
      {GLYPH_NODES.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === 9 || i === 10 ? 2.3 : 1.8} fill={GLYPH_KINDS[i % 4]} />
      ))}
    </svg>
  )
}
