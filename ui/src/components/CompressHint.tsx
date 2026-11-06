/**
 * The sidebar footer's hint to turn Compress tool output on (lib/compressHint;
 * .ai/04-ui.md § App sidebar footer). Unfolded, one quiet line with a × *Not
 * now*; folded, the database glyph with a dot, the line in its tooltip. A
 * click opens the switch in Settings → Storage and turns nothing on.
 */
import { compressHintText, compressHintTitle, openCompressSwitch, snoozeCompressHint, type CompressOffer } from '@/lib/compressHint'
import { CloseIcon, DatabaseIcon } from './AppIcons'

/** The accent dot that says the glyph has something to say. */
function Dot() {
  return <span aria-hidden data-hint-dot className="absolute right-[3px] top-[3px] h-[6px] w-[6px] rounded-full bg-accent" />
}

export function CompressHintRow({ offer }: { offer: CompressOffer }) {
  const title = compressHintTitle(offer)
  return (
    <div data-compress-hint className="app-row flex min-h-[32px] min-w-0 items-center gap-1 rounded-[8px] pr-1 text-[12px] text-fg-muted">
      <button
        type="button"
        onClick={openCompressSwitch}
        title={title}
        className="flex min-h-[32px] min-w-0 flex-1 items-center gap-2 rounded-[8px] py-1 pl-2 text-left hover:text-fg"
      >
        <span className="relative flex shrink-0">
          <DatabaseIcon size={15} className="text-fg-muted" />
          <span aria-hidden className="absolute -right-[2px] -top-[2px] h-[6px] w-[6px] rounded-full bg-accent" />
        </span>
        <span className="line-clamp-2 min-w-0 flex-1 leading-snug">{compressHintText(offer)}</span>
      </button>
      <button
        type="button"
        data-compress-hint-snooze
        onClick={() => snoozeCompressHint()}
        title="Not now: hide this for 30 days"
        aria-label="Not now"
        className="flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[6px] text-fg-faint transition-colors hover:bg-[var(--app-row-hover)] hover:text-fg motion-reduce:transition-none"
      >
        <CloseIcon size={11} />
      </button>
    </div>
  )
}

export function CompressHintIcon({ offer, className, size }: { offer: CompressOffer; className: string; size: number }) {
  const title = compressHintTitle(offer)
  return (
    <button type="button" data-compress-hint title={title} aria-label={title} onClick={openCompressSwitch} className={`relative ${className}`}>
      <DatabaseIcon size={size} />
      <Dot />
    </button>
  )
}
