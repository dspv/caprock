/**
 * A quiet line on a phone that opened Caprock by its Wi-Fi link.
 *
 * The owner, 2026-10-14 (translated): "the phone opens a link with IP 10.100
 * on the local network, no online, no internet… maybe I didn't finish setting
 * it up". His phone had paired on the Wi-Fi address a minute before access
 * from anywhere went on, and kept that link; on mobile data it reached nothing,
 * and no screen said why. The daemon knows how each request arrived
 * (`via` in `GET /v1/pair/me`), so the page that can still load — on the home
 * Wi-Fi — says what to do, naming the app and the path.
 *
 * Shown only on a paired device whose request came over the Wi-Fi listener;
 * never on the machine itself, over the relay, or over Tailscale.
 */
import { useEffect, useState } from 'react'
import { api, isPairedDevice } from '@/lib/api'

export function LanOnlyNotice() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!isPairedDevice()) return
    let live = true
    api.pairMe().then(
      (me) => { if (live) setShow(me.via === 'lan') },
      () => { /* unreachable: the page's own requests say why */ },
    )
    return () => { live = false }
  }, [])
  if (!show) return null
  return (
    <div role="note" data-testid="lan-only-notice" className="mb-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[13px] leading-snug text-fg">
      <span className="min-w-0 flex-1">
        This link works only on your home Wi-Fi. To use Caprock anywhere: in the Caprock app on your computer,{' '}
        <b className="font-medium">Settings → Use on your phone → Show a code</b>, and scan it.
      </span>
      <button onClick={() => setShow(false)} aria-label="Hide" className="shrink-0 px-1 text-fg-faint hover:text-fg">×</button>
    </div>
  )
}
