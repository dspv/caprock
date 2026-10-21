/**
 * Why a session waits, as a chip (.ai/04-ui.md § Needs you and Done). A
 * certain reason is filled; a guess has a dashed outline, no fill and the
 * word GUESS, with what it means on hover. "needs me?" moves a Done turn to
 * Needs you and "not needed" a guessed question back, until the next turn.
 */
import { useState } from 'react'
import { api, errText, type Need, type SessionSummary } from '@/lib/api'
import { GUESS_HINT, needLabel, needTone } from '@/lib/needs'

const TONE = {
  warn: { text: 'text-warn', fill: 'bg-warn/15' },
  danger: { text: 'text-danger', fill: 'bg-danger/15' },
  faint: { text: 'text-fg-faint', fill: '' },
}

export function NeedChip({ need, small = false }: { need?: Need; small?: boolean }) {
  const label = needLabel(need)
  if (!need || !label) return null
  const tone = TONE[needTone(need)]
  const guess = !!need.guess
  return (
    <span
      data-need={need.reason}
      data-guess={guess ? '' : undefined}
      title={guess ? GUESS_HINT : need.moved ? 'You moved it; it holds until the next turn.' : undefined}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full font-medium leading-none ${small ? 'px-1.5 py-[3px] text-[11px]' : 'px-2 py-1 text-[12px]'} ${tone.text} ${
        guess ? 'border border-dashed border-current bg-transparent' : tone.fill
      }`}
    >
      {label}
      {guess && <span className={`${small ? 'text-[9.5px]' : 'text-[10.5px]'} uppercase tracking-[0.06em] opacity-80`}>guess</span>}
    </span>
  )
}

/**
 * "needs me?" on a Done turn, "not needed" on a guessed question: a quiet
 * dotted link that tells the daemon (PUT /v1/sessions/{id}/needs). Nothing
 * for a certain reason, a moved turn's opposite stays offered.
 */
export function NeedMove({ s, onMoved, className = '' }: { s: Pick<SessionSummary, 'session_id' | 'status' | 'activity'>; onMoved?: () => void; className?: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const n = s.activity?.need
  if (s.status === 'ended' || !n) return null
  const done = s.activity.health === 'done'
  const canMove = done || (s.activity.health === 'waiting-on-you' && n.reason === 'asks' && (n.guess || n.moved))
  if (!canMove) return null
  const label = done ? 'needs me?' : 'not needed'
  return (
    <button
      type="button"
      data-need-move={done ? 'needs' : 'done'}
      disabled={busy}
      title={err || (done ? 'Move it to Needs you until its next turn' : 'Move it to Done until its next turn')}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setBusy(true)
        setErr('')
        api.setNeeds(s.session_id, done)
          .then(() => onMoved?.())
          .catch((x) => setErr(errText(x)))
          .finally(() => setBusy(false))
      }}
      className={`shrink-0 whitespace-nowrap text-[12px] text-fg-faint underline decoration-dotted underline-offset-2 hover:text-fg disabled:opacity-50 ${err ? 'text-danger' : ''} ${className}`}
    >
      {label}
    </button>
  )
}
