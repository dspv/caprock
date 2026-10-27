/**
 * "Try it without a Mac" (ADR-083): the dashboard itself, answered from the
 * bundled sample (index.ts), with a strip on top of every screen saying it is
 * sample data that connects to nothing, and the way out.
 */
import { Suspense, lazy, useState } from 'react'
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

export default function DemoApp({ onLeave }: { onLeave: () => void }) {
  const [asking, setAsking] = useState(false)
  return (
    <div className="flex min-h-dvh flex-col">
      <div data-testid="demo-strip" role="note" className="sticky top-0 z-50 flex items-center gap-2 border-b border-warn/40 bg-panel px-4 pb-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] text-[13px]">
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
