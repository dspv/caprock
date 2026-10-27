/**
 * "Try it without a Mac" (ADR-083): the dashboard itself, answered from the
 * bundled sample (index.ts), with a strip on top of every screen saying it is
 * sample data that connects to nothing, and the way out.
 */
import { Suspense, lazy, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { DEMO_MACHINE_NAME, installDemo } from './index'

const App = lazy(() => {
  installDemo()
  try {
    // The dashboard asks for figures only with a device token; this one is
    // answered by nothing but the sample.
    localStorage.setItem('caprock.device.token', 'demo')
  } catch { /* the dashboard asks to pair, which the demo refuses */ }
  return import('@/App')
})

/**
 * The strip already keeps clear of the notch, so the dashboard's own sticky
 * headers, which pad themselves by the same safe area, would leave a blank
 * band under it. In the demo they stick below the strip instead, with their
 * ordinary padding, and the page's own top inset (a session's screen pads
 * for the notch and pulls its bar back over that padding) shrinks to the
 * page's ordinary gap. Unlayered, so it wins over the utilities' layer.
 */
const UNDER_STRIP = `
html[data-demo] [data-shell-header],
html[data-demo] [data-phone-bar][data-sticky] {
  top: var(--demo-strip-h, 0px) !important;
  padding-top: 0.375rem !important;
}
html[data-demo] [data-shell-header] { margin-top: 0 !important; }
html[data-demo] main { padding-top: 0.75rem !important; }
html[data-demo] [data-chat-header] { padding-top: 0 !important; }
html[data-demo] main [data-phone-bar][data-sticky] { margin-top: -0.75rem !important; }`

/** Lays the dashboard's sticky headers below the strip while the demo is up. */
function useUnderStrip(strip: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const root = document.documentElement
    const style = document.createElement('style')
    style.dataset.demo = ''
    style.textContent = UNDER_STRIP
    document.head.appendChild(style)
    root.setAttribute('data-demo', '')
    const el = strip.current
    const size = () => root.style.setProperty('--demo-strip-h', `${el?.offsetHeight ?? 0}px`)
    size()
    const ro = typeof ResizeObserver === 'undefined' || !el ? null : new ResizeObserver(size)
    if (ro && el) ro.observe(el)
    return () => {
      ro?.disconnect()
      style.remove()
      root.removeAttribute('data-demo')
      root.style.removeProperty('--demo-strip-h')
    }
  }, [strip])
}

export default function DemoApp({ onLeave }: { onLeave: () => void }) {
  const [asking, setAsking] = useState(false)
  const strip = useRef<HTMLDivElement>(null)
  useUnderStrip(strip)
  return (
    <div className="flex min-h-dvh flex-col">
      <div ref={strip} data-testid="demo-strip" role="note" aria-label="Sample data" className="sticky top-0 z-50 flex items-center gap-2 border-b border-warn/40 bg-panel px-4 pb-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] text-[13px]">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-warn/60 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-warn">Sample data</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">{DEMO_MACHINE_NAME} · connects to nothing</span>
        <button type="button" onClick={() => setAsking(true)} className="min-h-9 shrink-0 px-1 font-medium text-accent">Leave</button>
      </div>
      {asking && (
        <div role="dialog" aria-modal="true" aria-label="Leave the demo" className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 px-3 pb-[max(1rem,env(safe-area-inset-bottom))]" onClick={() => setAsking(false)}>
          <div className="w-full max-w-md rounded-[14px] border border-border-strong bg-panel p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-[17px] font-semibold text-fg">Leave the demo?</p>
            <p className="mt-1.5 text-[15px] leading-snug text-fg-muted">Back to the first screen, to pair with your Mac. Nothing from the demo is kept.</p>
            <div className="mt-4 grid gap-2">
              <button type="button" onClick={onLeave} className="min-h-12 rounded-xl bg-accent text-[17px] font-semibold text-bg">Leave the demo</button>
              <button type="button" onClick={() => setAsking(false)} className="min-h-11 text-[16px] text-fg-muted">Stay</button>
            </div>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Suspense fallback={null}>
          <App />
        </Suspense>
      </div>
    </div>
  )
}
