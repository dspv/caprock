/**
 * The product-led surfaces: who may speak, when, and only one at a time.
 *
 * Caprock is free for one person and sells one thing — Caprock for Teams —
 * and asks for one favour, a GitHub star (no Premium since 2026-11-27,
 * ADR-022 amended). Every one of those asks is honest on its
 * own; together, stacked on one screen, they turn a tool into a page that
 * wants something. So:
 *
 *  - **One at a time.** Every offer registers here while it is eligible, and
 *    only the highest-priority one renders. Answering it lets the next one in.
 *  - **Only on the reader's own facts.** Each offer has a rule below, a pure
 *    function, tested: two or more people committing to the same code, real
 *    use for the star.
 *  - **Dismissal is remembered on the daemon** (lib/prompts.ts), so it holds
 *    across the app and a browser tab.
 *
 * .ai/04-ui.md § Product-led surfaces is the written version of these rules.
 */
import { useEffect, useId, useSyncExternalStore } from 'react'
import { api, isPairedDevice, type Settings } from '@/lib/api'
import { hydratePrompts, syncPromptsWith } from '@/lib/prompts'
import { isTauri } from '@/lib/appmode'
import { shell } from '@/lib/shell'
import { sellsHere } from '@/native/platform'

export type NudgeId =
  | 'teams-nudge' | 'share-moment' | 'setup' | 'mail' | 'offer' | 'star'

/**
 * Who wins when several are eligible. The offer tied to something happening
 * right now outranks the general ones; the star, which asks a favour rather
 * than answering a problem, comes last.
 */
export const NUDGE_PRIORITY: Record<NudgeId, number> = {
  'teams-nudge': 40,
  'share-moment': 30,
  // Above the general offers: it sets up the product, it does not sell it.
  setup: 25,
  // A new part of the product, offered once: below the offers tied to what is
  // happening now, above the star.
  mail: 22,
  // A question about a feature that may be built (ADR-062): below every
  // offer about something that exists.
  offer: 21,
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

/** The offers that sell something: never in the iOS app. */
const SELLING: ReadonlySet<NudgeId> = new Set<NudgeId>(['teams-nudge', 'offer'])

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
export function useNudgeSlot(id: NudgeId, offered: boolean): boolean {
  // The iOS app offers nothing for sale (ADR-083): those never compete there.
  const eligible = offered && (sellsHere() || !SELLING.has(id))
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
/**
 * The Mail offer: after real use (two days with sessions), never on a first
 * run, and only while no mail account exists. Opening Mail answers it.
 */
export const MAIL_MIN_DAYS = 2
export function mailEligible(totals: { days: number } | undefined, accounts: number | undefined): boolean {
  return !!totals && totals.days >= MAIL_MIN_DAYS && accounts === 0
}

export const STAR_MIN_DAYS = 3
export const STAR_MIN_SESSIONS = 10
export function starEligible(totals: { days: number; sessions: number } | undefined): boolean {
  return !!totals && totals.days >= STAR_MIN_DAYS && totals.sessions >= STAR_MIN_SESSIONS
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
