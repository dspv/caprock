/**
 * "↓ N new": shown while the reader is away from a list's live edge and rows
 * keep arriving (the scrolling rule, WP-11). Tapping it goes to the edge and
 * the list follows again. Positioned by the caller, over the list.
 */
export function NewPill({
  count,
  edge = 'bottom',
  unit = 'new',
  onJump,
  className = '',
}: {
  count: number
  edge?: 'bottom' | 'top'
  /** What a row is called: "new", "new lines". */
  unit?: string
  onJump: () => void
  className?: string
}) {
  if (count <= 0) return null
  return (
    <button
      type="button"
      onClick={onJump}
      data-new-pill
      className={`pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-accent/50 bg-panel/95 px-3 py-1 text-[12px] font-medium text-accent shadow-[var(--shadow-panel)] backdrop-blur-sm transition-colors hover:bg-accent hover:text-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none ${className}`}
    >
      <span aria-hidden>{edge === 'bottom' ? '↓' : '↑'}</span>
      <span className="num">{count > 999 ? '999+' : count}</span>
      <span>{unit}</span>
    </button>
  )
}
