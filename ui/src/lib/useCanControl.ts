import { useEffect, useState } from 'react'
import { api, isPairedDevice } from './api'

// The role this device holds, shared by every component that asks. '' until
// the daemon has answered, which draws a viewer's screen: showing controls that
// then disappear is worse than the reverse.
let role: '' | 'viewer' | 'controller' = ''
const listeners = new Set<() => void>()
let timer = 0

// How often a phone re-asks. The owner can take control away at any moment;
// the daemon enforces it at once, and this keeps the screen honest about it.
const RECHECK_MS = 15_000

async function load(): Promise<void> {
  try {
    const me = await api.pairMe()
    const next = me.role === 'controller' ? 'controller' : 'viewer'
    if (next === role) return
    role = next
    listeners.forEach((f) => f())
  } catch {
    /* unreachable or unpaired: keep what is shown; the page's own requests say why */
  }
}

/**
 * Whether this dashboard may start, type into and stop sessions.
 *
 * Always on the machine Caprock runs on. On a paired phone, only when the owner
 * made it a controller in Settings (ADR-034). The daemon enforces the role on
 * every request; this only decides which controls are drawn.
 */
export function useCanControl(): boolean {
  const paired = isPairedDevice()
  const [, rerender] = useState(0)
  useEffect(() => {
    if (!paired) return
    const changed = () => rerender((n) => n + 1)
    listeners.add(changed)
    if (listeners.size === 1) {
      void load()
      timer = window.setInterval(load, RECHECK_MS)
      // And on every screen change: a phone the owner just demoted should not
      // keep drawing controls for another 15 s on the next screen it opens.
      window.addEventListener('focus', load)
      window.addEventListener('hashchange', load)
    }
    return () => {
      listeners.delete(changed)
      if (listeners.size === 0) {
        window.clearInterval(timer)
        window.removeEventListener('focus', load)
        window.removeEventListener('hashchange', load)
      }
    }
  }, [paired])
  return !paired || role === 'controller'
}
