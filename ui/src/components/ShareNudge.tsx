/**
 * "Good numbers — show them off."
 *
 * Distinct from the share button, which is always there: someone who wants to
 * post their figures should never wait for permission, and whether they are
 * worth posting is their call. This is the extra nudge, for the moment a
 * person has something worth saying and might not have noticed.
 *
 * It says what the occasion is in their own numbers rather than asking in the
 * abstract. "You just passed $10,000 of Claude Code" is a reason; "share your
 * stats!" is an advertisement, and one people learn to look past.
 */
import { useState } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { findOccasion } from '@/lib/shareprompt'
import { isDue, markAnswered, type PromptKind } from '@/lib/prompts'
import { ShareDialog } from './Share'

const KIND: PromptKind = 'share-week'

export function ShareNudge({ now }: { now: number }) {
  const [shown] = useState(() => isDue(KIND, now))
  const [gone, setGone] = useState(false)
  const [open, setOpen] = useState(false)
  const hist = useApi(() => api.history('all'), [], { intervalMs: 300_000 })
  const week = useApi(() => api.summary('7d'), [], { intervalMs: 300_000 })

  if (!shown || gone) return null
  if (!hist.data || !week.data) return null
  const occasion = findOccasion(hist.data.totals, hist.data.daily ?? [], week.data)
  if (!occasion) return null

  const answer = () => { markAnswered(KIND, Date.now()); setGone(true) }

  return (
    <>
      <span className="inline-flex items-center gap-2.5 rounded-lg border border-accent/35 bg-accent/[0.07] py-1.5 pl-3.5 pr-2 text-[13px]">
        <span className="text-fg-muted">{occasion.line} Don&rsquo;t be shy and share it off —</span>
        <button
          onClick={() => { setOpen(true); answer() }}
          className="rounded-[5px] bg-accent px-3 py-1 font-medium text-panel hover:bg-accent/90"
        >
          Share
        </button>
        <button
          onClick={answer}
          title="hide this for a week"
          className="px-1 text-fg-faint hover:text-fg-muted"
        >
          ✕
        </button>
      </span>
      {open && <ShareDialog onClose={() => setOpen(false)} />}
    </>
  )
}
