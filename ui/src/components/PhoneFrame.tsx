/**
 * A browser tab's phone in phone mode (lib/phonemode.ts): a simple device
 * frame — status bar, the browser's bars, the home indicator — drawn around
 * the page area, the element the page's own window is laid over
 * (BrowserView). The frame is a picture; the page area is the truth, drawn
 * at the device's size in the window's logical pixels (CSS px divided by
 * the interface size), so the window laid over it is exactly that big.
 *
 * Three fits (`fitOf`): the whole phone; the page area alone in a thin rim
 * when the phone does not fit the tab; that rim drawn smaller when even it
 * does not fit (`scaled`: the caller passes the interface size divided by
 * `pageScale`, and the shell zooms the page out to match, so it still lays
 * out at the device's width). The page window is a native window nothing
 * here can clip, so the page area never runs past the tab.
 */
import type { ReactNode, Ref } from 'react'
import { PAGE_RIM, SE_CHIN, SE_FOREHEAD, type Band, type Device, type Fit, type Layout } from '@/lib/phonemode'

export interface PhoneFrameProps {
  device: Device
  layout: Layout
  rotate: boolean
  fit: Fit
  /** The interface size: device px are drawn at px / zoom CSS px. */
  zoom: number
  /** The address's host, for the drawn address bar. */
  host: string
  /** The page area: what the page's window is laid over. */
  pageRef: Ref<HTMLDivElement>
  /** What shows in the page area before (or instead of) the page. */
  children?: ReactNode
}

// The phone is a picture of a phone, the same in either theme.
const BODY = '#0d0d0c'
const EDGE = '#4a4743'
const CHROME = '#f2f2f4'
const INK = '#111'

export function PhoneFrame({ device: d, layout: l, rotate, fit, zoom, host, pageRef, children }: PhoneFrameProps) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const px = (n: number) => `${n / z}px`
  const page = (
    <div
      ref={pageRef}
      data-phone-page
      data-phone-size={`${l.pageW}x${l.pageH}`}
      className="relative shrink-0 overflow-hidden bg-bg"
      style={{ width: px(l.pageW), height: px(l.pageH) }}
    >
      {children}
    </div>
  )
  if (fit === 'page' || fit === 'scaled') {
    return (
      <div data-phone-fit={fit} className="shrink-0" style={{ padding: px(PAGE_RIM), background: BODY, borderRadius: px(12), boxShadow: `0 0 0 1px ${EDGE}` }}>
        {page}
      </div>
    )
  }
  const se = d.navKind === 'button' && d.id !== 'custom'
  const pad = se
    ? rotate ? `${px(14)} ${px(SE_CHIN)} ${px(14)} ${px(SE_FOREHEAD)}` : `${px(SE_FOREHEAD)} ${px(14)} ${px(SE_CHIN)}`
    : px(d.bezel)
  const band = (b: Band, i: number) => {
    const h = px(b.h)
    switch (b.kind) {
      case 'status':
        return (
          <div key={i} className="relative flex shrink-0 items-center justify-between font-semibold" style={{ height: h, padding: `0 ${px(26)}`, fontSize: px(15), color: INK, background: CHROME }}>
            <span>9:41</span>
            {d.cutout === 'island' && <span className="absolute left-1/2 -translate-x-1/2" style={{ top: px(11), width: px(124), height: px(36), borderRadius: px(20), background: '#000' }} />}
            {d.cutout === 'punch' && <span className="absolute left-1/2 -translate-x-1/2 rounded-full" style={{ top: px(10), width: px(12), height: px(12), background: '#000' }} />}
            <span aria-hidden className="flex items-end" style={{ gap: px(2) }}>
              {[5, 7, 9, 11].map((n) => <i key={n} style={{ width: px(3), height: px(n), background: INK, display: 'block', borderRadius: px(1) }} />)}
              <i style={{ width: px(22), height: px(11), marginLeft: px(5), border: `${px(1.5)} solid ${INK}`, borderRadius: px(3), display: 'block' }} />
            </span>
          </div>
        )
      case 'topbar':
        return (
          <div key={i} className="flex shrink-0 items-center" style={{ height: h, gap: px(8), padding: `0 ${px(10)}`, background: '#f1f3f4', borderBottom: '1px solid #ddd' }}>
            <div className="flex min-w-0 flex-1 items-center truncate" style={{ height: px(Math.min(36, b.h - 12)), borderRadius: px(18), background: '#e3e6e8', padding: `0 ${px(14)}`, fontSize: px(14), color: '#333' }}>{host}</div>
            <span style={{ fontSize: px(16), color: '#444' }}>⋮</span>
          </div>
        )
      case 'page':
        return (
          <div key={i} className="flex shrink-0 justify-center" style={{ height: h, background: CHROME }}>
            {page}
          </div>
        )
      case 'bottombar': {
        const full = !rotate && b.h >= 60
        return (
          <div key={i} className="flex shrink-0 flex-col items-center" style={{ height: h, gap: px(8), paddingTop: full ? px(8) : 0, justifyContent: full ? 'flex-start' : 'center', background: CHROME, borderTop: '1px solid #ddd' }}>
            {full ? (
              <>
                <div className="flex items-center justify-center truncate" style={{ width: '88%', height: px(40), borderRadius: px(14), background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.12)', fontSize: px(14), color: '#222' }}>{host}</div>
                <div aria-hidden className="flex justify-around" style={{ width: '88%', color: '#2563eb', fontSize: px(18) }}><span>‹</span><span>›</span><span>⎙</span><span>▢</span></div>
              </>
            ) : (
              <span style={{ fontSize: px(11), color: '#444' }}>{host}</span>
            )}
          </div>
        )
      }
      case 'nav':
        return (
          <div key={i} className="flex shrink-0 items-center justify-center" style={{ height: h, background: CHROME }}>
            <i style={{ display: 'block', width: px(d.navKind === 'home' ? 134 : 110), height: px(d.navKind === 'home' ? 5 : 4), borderRadius: px(3), background: d.navKind === 'home' ? INK : '#555' }} />
          </div>
        )
    }
  }
  return (
    <div
      data-phone-fit="full"
      className="relative shrink-0"
      style={{ padding: pad, background: BODY, borderRadius: px(se ? 52 : d.radius), boxShadow: `0 0 0 1.5px ${EDGE}, 0 30px 60px -30px rgba(0,0,0,.6)` }}
    >
      <div
        className="flex flex-col overflow-hidden"
        style={{ width: px(l.screenW), height: px(l.screenH), borderRadius: se ? px(4) : px(Math.max(0, d.radius - d.bezel)), background: CHROME, fontFamily: '-apple-system, system-ui, Roboto, sans-serif' }}
      >
        {l.bands.map(band)}
      </div>
      {se && (
        <i
          aria-hidden
          className="absolute block rounded-full"
          style={{
            width: px(46), height: px(46), border: `${px(2)} solid #444`,
            ...(rotate
              ? { right: px((SE_CHIN - 46) / 2), top: `calc(50% - ${px(23)})` }
              : { bottom: px((SE_CHIN - 46) / 2), left: `calc(50% - ${px(23)})` }),
          }}
        />
      )}
    </div>
  )
}
