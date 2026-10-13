import type { OverlapChip } from '@/lib/overlap'

/**
 * Another live session in the same checkout, on one line: a quiet chip when
 * they share only the folder, a warning when both edited the same files in
 * the last half hour (the list on hover), and the one way out. Shared with
 * the agent cockpit.
 */
export function OverlapLine({ chip, onMove, className = '' }: { chip: OverlapChip; onMove?: (chip: OverlapChip) => void; className?: string }) {
  const tone = chip.tone === 'warn' ? 'border-warn/50 bg-warn/15 text-warn' : 'border-border-strong bg-panel-2 text-fg-muted'
  return (
    <div data-pulse-chip className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] ${className}`}>
      <span title={chip.title} data-overlap={chip.tone} className={`inline-flex min-w-0 max-w-full items-center rounded-full border px-2 py-[1px] font-medium leading-[1.35] ${tone}`}>
        <span className="truncate">{chip.label}</span>
      </span>
      {onMove && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onMove(chip) }} className="link whitespace-nowrap"
          title={`Start a new session in a copy of the folder on its own branch, named after ${chip.newer.name}`}>
          Move to a worktree…
        </button>
      )}
    </div>
  )
}
