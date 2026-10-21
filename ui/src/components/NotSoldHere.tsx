/**
 * What the Premium and Teams dialogs show in the iOS app, which sells
 * nothing and points to no place where anything is sold (ADR-083): the
 * feature's name and a plain fact, no price, no link, no call to buy.
 */
import { DialogBackdrop } from './Dialog'
import { useDialogFocus } from './UpsellDialog'

export function NotSoldHere({ title, onClose }: { title: string; onClose: () => void }) {
  const panel = useDialogFocus()
  return (
    <DialogBackdrop
      onClose={onClose}
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/55 px-3 py-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div ref={panel} data-testid="not-sold-here" className="w-[420px] max-w-full rounded-[14px] border border-border-strong bg-panel p-5 shadow-[var(--shadow-panel)]" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-[19px] font-semibold text-fg">{title}</h2>
        <p className="mt-2 text-[15px] leading-snug text-fg-muted">
          Not part of what Caprock on your computer has turned on. When it is, it works here too.
        </p>
        <button type="button" onClick={onClose} className="mt-5 min-h-11 w-full rounded-xl border border-border-strong text-[16px] text-fg">
          Close
        </button>
      </div>
    </DialogBackdrop>
  )
}
