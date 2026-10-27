/**
 * What the 0073 upgrade left to say (03-contracts.md § Session key DDL).
 *
 * While the events stored before it move into place, older history is
 * partial: the Now screen says so at length, and History, Memory's search
 * and a session page in one quiet line (`MovingLine`), gone once the move
 * ends. An upgrade that found no disk for its safety copy has no way back to
 * an older release, and a log line was all that said so (`CopySkipped`).
 */
import { api, type Status } from '@/lib/api'
import { useApi } from '@/lib/useApi'

type Move = NonNullable<Status['events_move']>
type Skip = NonNullable<Status['upgrade_copy_skipped']>

/** Of the events to move, how many are in place, as a whole percent rounded down. */
export function movedPct(m: Move): number {
  return Math.min(100, Math.floor((m.moved * 100) / Math.max(m.total, 1)))
}

/** A size the way the OS names it: 1.2 GB, 340 MB (powers of 1024, as `caprock status`). */
function size(n: number): string {
  const k = 1024
  if (n >= k * k * k) return `${(n / (k * k * k)).toFixed(1)} GB`
  if (n >= k * k) return `${Math.round(n / (k * k))} MB`
  return `${Math.max(0, Math.round(n / k))} KB`
}

/** The warning, in words: why no copy was made, and what that costs. */
export function copySkippedText(c: Skip): string {
  const why = c.error
    ? `it could not be made (${c.error})`
    : `${size(c.free_bytes ?? 0)} free, ${size(c.need_bytes ?? 0)} needed`
  return `No safety copy of the database was made before the upgrade: ${why}. Older Caprock versions cannot open the upgraded database.`
}

/** The skipped copy, as a warning: Now while the move runs, Status for as long as the daemon reports it. */
export function CopySkipped({ skip }: { skip: Skip }) {
  return (
    <div data-copy-skipped role="status" className="border border-warn/50 bg-warn/10 px-3 py-2 text-[12px] rounded-[var(--radius-panel)] flex items-baseline gap-3">
      <span className="text-warn font-medium whitespace-nowrap">No way back</span>
      <span className="text-fg-muted">{copySkippedText(skip)}</span>
    </div>
  )
}

/** One quiet line while older history moves in; nothing otherwise. Asks the
 *  status itself, shared with any other screen asking at about the same time. */
export function MovingLine({ className = '' }: { className?: string }) {
  const st = useApi(() => api.status(), [], { live: false, intervalMs: 30000, share: 'status' })
  const move = st.data?.events_move
  if (!move) return null
  return (
    <p data-moving-line className={`text-[12px] text-fg-muted ${className}`}>
      Older history is still loading — <span className="num text-fg">{movedPct(move)}%</span> moved. Until then, older
      sessions and totals over them are incomplete.
    </p>
  )
}
