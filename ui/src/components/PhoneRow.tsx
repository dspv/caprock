/**
 * Phone mode's *Side by side* (lib/phonemode.ts SIDE_DEVICES): the same
 * page in three phones in a row — iPhone SE, iPhone 16, Pixel 9 — each
 * drawn whole by PhoneFrame at one shared scale, its page window laid over
 * its page area (BrowserView), and named under it: *iPhone SE · 375*. A
 * click on the name goes back to that one phone.
 *
 * A phone whose page is wider than it (the shell's `measure`) wears a red
 * *cut off* on its top edge, outside the page area so the page's window
 * never covers it. A phone scrolled partly out of the stage has its page
 * window hidden — a native window is never clipped, and would draw over
 * the panes beside — and says so until it is scrolled back.
 */
import type { ReactNode } from 'react'
import { SIDE_GAP, SIDE_LABEL, SIDE_MARGIN, SIDE_NAMES, layoutOf, type Bars, type Device, type DeviceId } from '@/lib/phonemode'
import { PhoneFrame } from './PhoneFrame'

export interface PhoneRowProps {
  devices: readonly Device[]
  bars: Bars
  /** The phones' shared scale (`sideScale`). */
  scale: number
  /** The interface size (lib/uiscale). */
  zoom: number
  host: string
  /** Each phone's page area, for its page window. */
  pageRef: (id: DeviceId) => (el: HTMLDivElement | null) => void
  /** The document's width, by phone, when it is wider than that phone. */
  wide: Partial<Record<DeviceId, number>>
  /** Phones scrolled partly out of view: their page windows are hidden. */
  out: Partial<Record<DeviceId, boolean>>
  onPick: (id: DeviceId) => void
  /** What shows in each page area before (or instead of) the page. */
  content?: ReactNode
}

export function PhoneRow({ devices, bars, scale, zoom, host, pageRef, wide, out, onPick, content }: PhoneRowProps) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return (
    <div className="flex h-full w-full overflow-auto" data-phone-row>
      <div className="m-auto flex w-max items-end" style={{ gap: SIDE_GAP, padding: SIDE_MARGIN }}>
        {devices.map((d) => {
          const name = SIDE_NAMES[d.id] ?? d.name
          const doc = wide[d.id]
          return (
            <div key={d.id} className="flex flex-none flex-col items-center" data-side-phone={d.id}>
              <div className="relative">
                <PhoneFrame device={d} layout={layoutOf(d, bars, false)} rotate={false} fit="full" zoom={z / scale} host={host} pageRef={pageRef(d.id)}>
                  {out[d.id] ? (
                    <div className="flex h-full items-center justify-center px-3 text-center text-[12px] text-fg-muted">Scroll to see this phone</div>
                  ) : content}
                </PhoneFrame>
                {doc !== undefined && (
                  <span
                    role="status"
                    data-cut-off={d.id}
                    title={`The page is ${doc} px wide, wider than ${name}’s ${d.w}: it runs past the edge and scrolls sideways`}
                    className="absolute -top-[9px] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[4px] bg-[#d0463b] px-1.5 py-px text-[11px] font-semibold text-white shadow"
                  >
                    cut off
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => onPick(d.id)}
                title={`Back to one phone: ${name}`}
                className="mt-1 flex items-center rounded-[6px] px-1.5 text-[12px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
                style={{ height: SIDE_LABEL - 4 }}
              >
                <b className="font-semibold text-fg">{name}</b>&nbsp;· {d.w}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
