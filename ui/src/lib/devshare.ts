/**
 * *Open on my phone* (ADR-087): a local dev server opened on a real phone on
 * the same Wi-Fi, through a proxy the daemon opens for that one origin behind
 * a link (internal/devshare). This holds what is shared for every tab of the
 * window, so the device bar's button and a tab's strip agree.
 *
 * - **Local only.** The button exists for an address `devUrlOf` calls local
 *   (lib/devservers.ts): the same rules as *Preview on phone*.
 * - **Looked at, not watched.** The list is read once when a local page's tab
 *   asks, after a start or a stop, and every POLL_MS only while something is
 *   shared, so a share that ended by itself (30 minutes unused) stops showing.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { api, errText, type DevShare } from './api'
import { devUrlOf } from './devservers'

/** How often the list is read again while something is shared. */
export const POLL_MS = 15_000

/** The origin a local address is shared by, or null for one that is not a local dev server's. */
export function shareOrigin(url: string): string | null {
  if (!url) return null
  const local = devUrlOf(url)
  if (!local) return null
  try { return new URL(local).origin } catch { return null }
}

function originOf(target: string): string {
  try { return new URL(target).origin } catch { return target }
}

interface State { shares: DevShare[]; idleMin: number; loaded: boolean }

let state: State = { shares: [], idleMin: 30, loaded: false }
const subs = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let loading: Promise<void> | null = null

function set(next: Partial<State>) {
  state = { ...state, ...next }
  for (const f of subs) f()
  if (state.shares.length && !timer) timer = setInterval(() => { void refresh() }, POLL_MS)
  if (!state.shares.length && timer) { clearInterval(timer); timer = null }
}

/** Reads the list from the daemon; a failure leaves it as it was. */
export function refresh(): Promise<void> {
  if (loading) return loading
  loading = api.devShares()
    .then((l) => set({ shares: l.shares ?? [], idleMin: Math.round((l.idle_sec || 1800) / 60), loaded: true }))
    .catch(() => set({ loaded: true }))
    .finally(() => { loading = null })
  return loading
}

/** Tests: back to nothing known. */
export function resetDevShares(): void {
  if (timer) clearInterval(timer)
  timer = null
  loading = null
  state = { shares: [], idleMin: 30, loaded: false }
  for (const f of subs) f()
}

function subscribe(f: () => void) {
  subs.add(f)
  return () => { subs.delete(f) }
}

export interface DevShareHook {
  /** The address can be shared: a local dev server's. */
  shareable: boolean
  /** Its share, while one is open. */
  share: DevShare | null
  /** Minutes unused before a share ends by itself. */
  idleMin: number
  start: () => Promise<DevShare>
  stop: () => Promise<void>
}

/** The share for `url`'s origin, and how to start or stop it. */
export function useDevShare(url: string): DevShareHook {
  const origin = shareOrigin(url)
  const st = useSyncExternalStore(subscribe, () => state)
  useEffect(() => {
    if (origin && !st.loaded) void refresh()
  }, [origin, st.loaded])
  const share = origin ? st.shares.find((s) => originOf(s.target) === origin) ?? null : null
  const start = useCallback(async () => {
    const local = devUrlOf(url)
    if (!local) throw new Error('Only a local dev server’s page can be opened on a phone.')
    try {
      const sh = await api.startDevShare(local)
      set({ shares: [...state.shares.filter((s) => s.id !== sh.id), sh], loaded: true })
      return sh
    } catch (e) {
      throw new Error(errText(e))
    }
  }, [url])
  const stop = useCallback(async () => {
    if (!share) return
    try {
      await api.stopDevShare(share.id)
    } finally {
      set({ shares: state.shares.filter((s) => s.id !== share.id) })
    }
  }, [share])
  return { shareable: !!origin, share, idleMin: st.idleMin, start, stop }
}
