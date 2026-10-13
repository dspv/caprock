/**
 * The headline against the viewer's own usual (lib/usual.ts), as text on
 * the line under the big figure, left of its name: *▲ 38%*, *≈ usual*,
 * *▼ 55%*, *▲ 4.5×*, *▼ 9 pts* (owner, 2026-10-13, picked from four forms
 * on a local compare page). Amber only when there is something to act on
 * (`tone`); hovering says it in full. Nothing at all without a usual — a
 * new user, or a metric with none — so nothing appears and nothing moves.
 */
import { fmtTokens, fmtUSD } from '@/lib/format'
import { arrow, deltaText, tone, versusTitle, type Versus } from '@/lib/usual'

const TONE_TEXT = { warn: 'text-warn', none: 'text-fg-muted' } as const

export function UsualDelta({ v, days }: { v: Versus; days: number }) {
  const title = versusTitle(v, v.metric === 'tokens' ? (n) => `${fmtTokens(n)} tokens` : fmtUSD, days)
  return (
    <span data-usual={v.near ? 'near' : v.delta > 0 ? 'above' : 'below'} className={`num whitespace-nowrap text-[11.5px] leading-[16px] ${TONE_TEXT[tone(v)]}`}
      title={title} aria-label={title}>
      {v.near ? <>≈ usual</> : <><span aria-hidden className="text-[8.5px]">{arrow(v)}</span> {deltaText(v)}</>}
    </span>
  )
}
