/**
 * The product-led surfaces: who may speak, when, and only one at a time.
 *
 * Caprock is free and sells two things — Premium and Caprock for Teams — and
 * asks for one favour, a GitHub star. Every one of those asks is honest on its
 * own; together, stacked on one screen, they turn a tool into a page that
 * wants something. So:
 *
 *  - **One at a time.** Every offer registers here while it is eligible, and
 *    only the highest-priority one renders. Answering it lets the next one in.
 *  - **Only on the reader's own facts.** Each offer has a rule below, a pure
 *    function, tested: a plan window at 80%, a day in the top quarter of this
 *    machine's own days, two or more people committing to the same code.
 *  - **Never to a payer.** A Premium offer asks `useLicensed` first.
 *  - **Dismissal is remembered on the daemon** (lib/prompts.ts), so it holds
 *    across the app and a browser tab.
 *
 * .ai/04-ui.md § Product-led surfaces is the written version of these rules.
 */
import { useEffect, useId, useSyncExternalStore } from 'react'
import { api, isPairedDevice, type DailyStat, type RateLimits, type Settings } from '@/lib/api'
import { hydratePrompts, syncPromptsWith } from '@/lib/prompts'
import { useApi } from '@/lib/useApi'
import { isTauri } from '@/lib/appmode'
import { shell } from '@/lib/shell'

export type NudgeId =
  | 'premium-limit' | 'premium-hint' | 'premium-cap' | 'premium-banner'
  | 'teams-nudge' | 'share-moment' | 'star'

/**
 * Who wins when several are eligible. The offer tied to something happening
 * right now outranks the general ones; the star, which asks a favour rather
 * than answering a problem, comes last.
 */
export const NUDGE_PRIORITY: Record<NudgeId, number> = {
  'premium-limit': 70,
  'premium-hint': 60,
  'premium-cap': 50,
  'teams-nudge': 40,
  'share-moment': 30,
  'premium-banner': 20,
  star: 10,
}

/** The winner among registered instances: highest priority, then first registered. */
export function pickNudge(entries: { key: string; id: NudgeId; order: number }[]): string | null {
  let best: { key: string; id: NudgeId; order: number } | null = null
  for (const e of entries) {
    if (!best || NUDGE_PRIORITY[e.id] > NUDGE_PRIORITY[best.id]
      || (NUDGE_PRIORITY[e.id] === NUDGE_PRIORITY[best.id] && e.order < best.order)) best = e
  }
  return best?.key ?? null
}

const slots = new Map<string, { key: string; id: NudgeId; order: number }>()
const listeners = new Set<() => void>()
let counter = 0
let winner: string | null = null

function recompute() {
  const next = pickNudge([...slots.values()])
  if (next === winner) return
  winner = next
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/**
 * Ask for the one slot. Returns true when this instance is the one offer on
 * screen. `eligible` is the offer's own rule; while it is false the instance
 * does not compete.
 */
export function useNudgeSlot(id: NudgeId, eligible: boolean): boolean {
  const key = useId()
  useEffect(() => {
    if (!eligible) return
    slots.set(key, { key, id, order: counter++ })
    recompute()
    return () => { slots.delete(key); recompute() }
  }, [key, id, eligible])
  const won = useSyncExternalStore(subscribe, () => winner)
  return eligible && won === key
}

/** For tests: forget every registration. */
export function resetNudgeSlots() {
  slots.clear()
  winner = null
  counter = 0
}

/**
 * Whether a Premium licence is active. Unknown reads as "not licensed": the
 * offers that use it all wait on other data first, by which time this has
 * answered, and the answer is kept between loads.
 */
export function useLicensed(): boolean {
  const p = useApi(() => api.premium(), [], { live: false, intervalMs: 300_000, cache: 'premium-license' })
  return !!p.data?.license?.active
}

let syncing = false

/**
 * Load the daemon's prompt answers and write new ones back. Mounted once by
 * the dashboard's Shell and the app's AppShell. A paired device may not write
 * settings (ADR-029), so its answers stay in its own browser.
 */
export function usePromptSync() {
  useEffect(() => {
    if (syncing) return
    syncing = true
    api.settings().then((s) => hydratePrompts(s.prompts)).catch(() => { /* an older daemon: local answers only */ })
    if (!isPairedDevice()) {
      syncPromptsWith((patch) => {
        void api.saveSettings({ prompts: patch } as unknown as Settings).catch(() => { /* kept locally */ })
      })
    }
  }, [])
}

// ---- The rules ------------------------------------------------------------

/**
 * The star strip: after real use, never on a first run. Three different days
 * with sessions and ten sessions in all — someone who has come back, not
 * someone still finding out what the window is.
 */
export const STAR_MIN_DAYS = 3
export const STAR_MIN_SESSIONS = 10
export function starEligible(totals: { days: number; sessions: number } | undefined): boolean {
  return !!totals && totals.days >= STAR_MIN_DAYS && totals.sessions >= STAR_MIN_SESSIONS
}

/** The plan-window nudge: a Claude window at 80% or more. */
export const LIMIT_NUDGE_PCT = 80
export function limitNudge(limits: RateLimits | undefined): { name: string; pct: number } | null {
  if (!limits) return null
  const rows = [
    { name: '5-hour', pct: limits.five_hour?.used_percentage },
    { name: 'weekly', pct: limits.seven_day?.used_percentage },
  ].filter((r): r is { name: string; pct: number } => typeof r.pct === 'number' && r.pct >= LIMIT_NUDGE_PCT)
  if (rows.length === 0) return null
  return rows.reduce((a, b) => (b.pct > a.pct ? b : a))
}

/**
 * The daily-cap nudge: today's spend is in the top quarter of this machine's
 * own days. Needs eight earlier days with spend, so a quartile means
 * something; today must also be above zero.
 */
export const CAP_MIN_DAYS = 8
export function capNudge(daily: Pick<DailyStat, 'day' | 'cost_usd'>[], today: string, todayCost: number): boolean {
  if (!(todayCost > 0)) return false
  const byDay = new Map<string, number>()
  for (const d of daily) if (d.day !== today) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.cost_usd)
  const past = [...byDay.values()].filter((v) => v > 0).sort((a, b) => a - b)
  if (past.length < CAP_MIN_DAYS) return false
  const q3 = past[Math.floor(past.length * 0.75)]!
  return todayCost >= q3
}

/** The team nudge: two or more people committed to the listed repositories in 30 days. */
export function teamEligible(sig: { authors: number } | undefined): boolean {
  return !!sig && sig.authors >= 2
}

/** Where the team card links; `ref=app` is the only attribution (rule 4). */
export const TEAMS_URL = 'https://caprock.dev/teams/?ref=app'
export const REPO_URL = 'https://github.com/dspv/caprock'

/**
 * Opens a link in the default browser: the desktop app's `open_external`, a
 * new tab in a browser. Same path as a terminal link (lib/termlinks.ts),
 * without pulling the terminal's code into the dashboard.
 */
export function openExternal(url: string): void {
  const viaPage = () => { window.open(url, '_blank', 'noopener') }
  if (isTauri()) {
    shell.openExternal(url).catch(viaPage)
    return
  }
  viaPage()
}
