/**
 * The rates behind every plan figure on the page (GET /v1/plan-share): one
 * read shared by every figure, again every five minutes while one is shown,
 * and the last answer kept per viewer so a figure draws with its plan line
 * on the first paint instead of growing a line a moment later.
 */
import { useSyncExternalStore } from 'react'
import { ApiError, api } from '@/lib/api'
import { asRates, type PlanRates } from '@/lib/planShare'

const STORE_KEY = 'caprock.planShare.rates'
/** How often a page that shows a plan figure asks for the rates again. */
export const RATES_REFRESH_MS = 5 * 60_000

let current: PlanRates | undefined = (() => {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORE_KEY)
    return raw ? asRates(JSON.parse(raw)) : undefined
  } catch {
    return undefined
  }
})()
let lastRead = 0
let inflight: Promise<void> | undefined
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

async function readRates(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      set(asRates(await api.planShare()))
    } catch (e) {
      // An older daemon (404), none (501) or a device not allowed it (403):
      // no plan figures rather than a stale set. Offline keeps what is shown.
      if (e instanceof ApiError && (e.status === 404 || e.status === 501 || e.status === 403)) set(undefined)
    } finally {
      lastRead = Date.now()
      inflight = undefined
    }
  })()
  return inflight
}

function set(next: PlanRates | undefined) {
  current = next
  try {
    if (next) localStorage.setItem(STORE_KEY, JSON.stringify(next))
    else localStorage.removeItem(STORE_KEY)
  } catch { /* storage refused: the next page load asks again */ }
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  if (Date.now() - lastRead > RATES_REFRESH_MS) void readRates()
  if (!timer) timer = setInterval(() => { if (!document.hidden) void readRates() }, RATES_REFRESH_MS)
  return () => {
    listeners.delete(l)
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = undefined }
  }
}

const snapshot = () => current

/** The rates behind every plan figure on the page: one read, shared. */
export function usePlanRates(): PlanRates | undefined {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** For tests: put rates in place without a read. */
export function setPlanRatesForTest(r: PlanRates | undefined) {
  lastRead = r ? Date.now() : 0
  current = r
  for (const l of listeners) l()
}
