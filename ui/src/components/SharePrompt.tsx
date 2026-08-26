/**
 * The offer to share, on a rhythm rather than only at a round number.
 *
 * The share button has always been there, quietly, next to the all-time
 * figures. It went loud only when someone crossed $1,000 or $10,000 — so a
 * person whose spend never lands on a round number was never actually asked,
 * and the people most likely to post about a week of work are exactly the ones
 * who have not spent four figures.
 *
 * This asks once a week and once a month, remembers the answer either way, and
 * says plainly what the image contains before anyone clicks. The card carries
 * totals and no project names, no paths and no prose — but a person deciding
 * whether to post their own numbers should be told that, not have to trust it.
 */
import { useState } from 'react'
import { ShareCard, type SharePeriod } from './ShareCard'
import { dueShare, markAnswered, type PromptKind } from '@/lib/prompts'

type ShareKind = Extract<PromptKind, 'share-week' | 'share-month'>

const COPY: Record<ShareKind, { title: string; period: SharePeriod }> = {
  'share-week': { title: 'A week of work', period: '7d' },
  'share-month': { title: 'A month of work', period: '30d' },
}

export function SharePrompt({ now }: { now: number }) {
  // Read once per mount: re-reading on every render would make the banner
  // vanish mid-interaction the moment anything else answered a prompt.
  const [kind] = useState<ShareKind | null>(() => dueShare(now))
  const [gone, setGone] = useState(false)
  if (!kind || gone) return null
  const { title, period } = COPY[kind]

  const answer = () => { markAnswered(kind, Date.now()); setGone(true) }

  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-panel)] border border-border bg-panel-2 px-3 py-2 text-[12px]">
      <span className="font-medium text-fg">{title}</span>
      <span className="text-fg-muted">
        Draw a card of the totals — cost, sessions, turns.{' '}
        <span className="text-fg-faint">
          No project names, paths or prose; it saves to your downloads and nothing is uploaded.
        </span>
      </span>
      <span className="ml-auto flex items-center gap-2 shrink-0">
        {/* Answering by taking it counts the same as dismissing: someone who
          * just drew this week's card has nothing new to draw tomorrow. */}
        <span onClick={answer}><ShareCard period={period} /></span>
        <button
          onClick={answer}
          className="text-[11px] text-fg-faint hover:text-fg-muted border border-border px-1.5 py-0.5 rounded-sm"
        >
          not now
        </button>
      </span>
    </div>
  )
}
