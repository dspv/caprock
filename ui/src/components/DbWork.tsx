/**
 * The status strip's database indicator (lib/dbWork; .ai/04-ui.md § The
 * status strip): its own item in the window's bottom strip, beside keep-awake.
 * *Compressing · 40% · 224.6MB saved* with a hairline bar while compression
 * runs; *Pack database · ~85 s* once a pack is worth it; *Packing · 46%* over
 * a real progress bar during one; *Packed · 2.1GB → 1.6GB* for a minute after.
 * A click opens a small popover above it with the details, the estimate and,
 * for the offer, **Pack now** and *Not now*. Absent when there is nothing to
 * say.
 */
import { useEffect, useState } from 'react'
import { dbWorkChip, dbWorkDetail, dbWorkText, dbWorkTitle, fmtSeconds, useDbWork, type DbWork } from '@/lib/dbWork'
import { fmtBytes } from '@/lib/format'
import { CloseIcon, DatabaseIcon } from './AppIcons'

/** The share the bar fills: undefined draws the moving stripe. */
function share(w: DbWork): number | undefined {
  switch (w.kind) {
    case 'compressing':
    case 'restoring':
      return w.progress
    case 'packing':
      return w.run.progress >= 0 ? w.run.progress : undefined
    default:
      return undefined
  }
}

function running(w: DbWork): boolean {
  return w.kind === 'compressing' || w.kind === 'restoring' || w.kind === 'packing'
}

/** A bar filled to the share, or a stripe moving across where the phase has no reading. */
export function WorkBar({ value, strong, height = 3 }: { value?: number; strong?: boolean; height?: number }) {
  return (
    <span
      aria-hidden
      data-work-bar={value === undefined ? 'indeterminate' : String(Math.round(value * 1000) / 1000)}
      style={{ height }}
      className="relative block w-full overflow-hidden rounded-full bg-[var(--app-hairline-strong)]"
    >
      {value === undefined ? (
        <span className="app-work-stripe absolute inset-y-0 w-1/3 rounded-full bg-accent" />
      ) : (
        <span
          className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 motion-reduce:transition-none ${strong ? 'bg-accent' : 'bg-fg-muted'}`}
          style={{ width: `${Math.max(value * 100, 2)}%` }}
        />
      )}
    </span>
  )
}

/** The strip's item. */
export function DbWorkIndicator() {
  const { work, start, error, snooze } = useDbWork()
  const [open, setOpen] = useState(false)
  if (!work) return null
  const bar = running(work)
  const lit = work.kind === 'offer' || work.kind === 'packing'
  return (
    <span className="relative">
      <button
        type="button"
        data-db-work={work.kind}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={`${dbWorkTitle(work)} Click for details.`}
        className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-[5px] px-1 hover:bg-[var(--app-row-hover)] ${
          work.kind === 'failed' ? 'text-warn' : lit ? 'text-accent' : 'text-fg-muted'}`}
      >
        <DatabaseIcon size={12} />
        <span className="num">{dbWorkChip(work)}</span>
        {bar && <span className="inline-block w-[44px]"><WorkBar value={share(work)} strong={work.kind === 'packing'} /></span>}
      </button>
      {open && <DbWorkPopover work={work} start={start} error={error} snooze={snooze} onClose={() => setOpen(false)} />}
    </span>
  )
}

/** The details above the strip: what is happening, the estimate, and the pack's buttons. */
function DbWorkPopover({ work, start, error, snooze, onClose }: { work: DbWork; start: () => Promise<void>; error: string; snooze: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <>
      <span aria-hidden className="fixed inset-0 z-40" onClick={onClose} />
      <div role="dialog" aria-label="Database" data-db-work-popover
        className="absolute bottom-[calc(100%+8px)] right-0 z-50 grid w-[320px] gap-2.5 rounded-[10px] border border-border-strong bg-panel p-3.5 text-left text-[13px] text-fg-muted shadow-lg">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-[15px] font-semibold text-fg"><DatabaseIcon size={15} />Database</span>
          <button type="button" aria-label="Close" title="Close (Esc)" onClick={onClose}
            className="-mr-1 grid h-7 w-7 place-items-center rounded-md text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
            <CloseIcon size={14} />
          </button>
        </div>
        <p className="text-[14px] font-medium text-fg">{dbWorkText(work)}</p>
        {running(work) && <WorkBar value={share(work)} strong={work.kind === 'packing'} height={6} />}
        {work.kind === 'offer' ? (
          <>
            <p className="leading-snug">
              Rewrites the <span className="num text-fg">{fmtBytes(work.dbBytes)}</span> file without its empty space: about{' '}
              <span className="text-fg">{fmtSeconds(work.offer.est_seconds)}</span>, frees ~<span className="num text-fg">{fmtBytes(work.offer.free_bytes_est)}</span>.
              Sessions keep running; new events wait about <span className="text-fg">{fmtSeconds(work.offer.hold_seconds_est)}</span> and are recorded when it is done.
            </p>
            <p className="text-[12px] text-fg-faint">
              Estimates: the saving from {work.offer.sampled_pages.toLocaleString('en-US')} of the file's pages, the time
              {work.offer.rate_measured ? ' from the last pack on this computer.' : ' from a measured pack, until this computer has run one.'}
            </p>
            {error && <p className="text-[12px] text-warn">{error}</p>}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-pack-now
                disabled={busy}
                onClick={() => { setBusy(true); void start().finally(() => setBusy(false)) }}
                className="h-[28px] rounded-[6px] bg-accent px-3 text-[13px] font-medium text-panel hover:brightness-110 disabled:opacity-50"
              >
                Pack now
              </button>
              <button type="button" data-pack-snooze onClick={() => { snooze(); onClose() }} title="Hide this offer for 7 days"
                className="h-[28px] rounded-[6px] px-3 text-[13px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
                Not now
              </button>
            </div>
          </>
        ) : (
          <p className="leading-snug">{dbWorkDetail(work)}</p>
        )}
      </div>
    </>
  )
}
