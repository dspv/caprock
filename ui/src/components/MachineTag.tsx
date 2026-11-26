/**
 * Which computer a session runs on, as a small outlined tag (ADR-067): on
 * its sidebar row under Computers, its row under Open and its tab in the
 * strip, so a session on another computer never reads as this one's.
 */
export function MachineTag({ name, className = '' }: { name: string; className?: string }) {
  return (
    <span
      data-machine-tag
      title={`On ${name}`}
      className={`max-w-[40%] shrink-0 truncate rounded-[4px] border border-[var(--app-hairline-strong)] px-1 text-[10.5px] font-normal text-fg-faint ${className}`}
    >
      {name}
    </span>
  )
}
