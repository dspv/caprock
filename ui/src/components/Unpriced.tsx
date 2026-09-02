import type { Unpriced } from '@/lib/api'
import { fmtTokens } from '@/lib/format'

/**
 * A model that is not in the pricing table leaves its cost unknown, and every
 * aggregate used to flatten that into the total — so tokens of a model shipped
 * after the pricing table rendered as a confident "$0.00", indistinguishable
 * from free. That is an invented number, so the volume is reported instead.
 *
 * The model ids are named, not just counted: a user who can see "we could not
 * price claude-opus-9" can tell us, pin a pricing override, or recognise their
 * gateway's non-normalising ids. "Some tokens are unpriced" is not actionable.
 */
export function UnpricedNote({ u, className = '' }: { u?: Unpriced; className?: string }) {
  if (!u || u.turns === 0) return null
  return (
    <div className={`border border-warn/50 bg-warn/10 px-3 py-2 text-[12px] rounded-[var(--radius-panel)] ${className}`}>
      <span className="text-warn font-medium">Cost is incomplete</span>{' '}
      <span className="text-fg-muted">
        {fmtTokens(u.tokens)} tokens over {u.turns} turn{u.turns === 1 ? '' : 's'} could not be priced, so they are
        missing from the total above — not free. {u.models.length === 1 ? 'Model' : 'Models'} with no entry in the
        pricing table:{' '}
        {u.models.map((m, i) => (
          <span key={m}>
            {i > 0 && ', '}
            <span className="mono text-fg">{m || 'unknown'}</span>
          </span>
        ))}
        . This happens when a model ships newer than the pricing table, or when a gateway reports ids that do not
        normalise.
      </span>
    </div>
  )
}

