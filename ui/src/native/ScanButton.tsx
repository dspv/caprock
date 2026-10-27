/**
 * "Scan the code" in the iOS app: opens the camera scanner (native/scan.ts,
 * loaded on the tap) and opens the pairing link it reads. Rendered only where
 * isNativeApp() is true; the web page pairs through the phone's camera app.
 */
import { useState } from 'react'
import { NOT_A_LINK, openPairLink } from './pairing'

export function ScanButton({ label = 'Scan the code', className, onError }: { label?: string; className?: string; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  async function scan() {
    setBusy(true)
    onError('')
    try {
      const { scanCode } = await import('./scan')
      const r = await scanCode()
      if ('text' in r) {
        if (!openPairLink(r.text)) onError(NOT_A_LINK)
      } else if ('error' in r) onError(r.error)
    } catch {
      onError('The camera scanner did not open. Paste the link instead.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      data-testid="native-scan"
      disabled={busy}
      onClick={() => void scan()}
      className={className ?? 'flex min-h-[52px] w-full items-center justify-center gap-2 rounded-[14px] bg-accent text-[17px] font-semibold text-bg shadow-[0_8px_20px_-10px_var(--accent)] disabled:opacity-60'}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M7 12h10" />
      </svg>
      {label}
    </button>
  )
}
