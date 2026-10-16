/**
 * The answer to a check the user asked for (owner, 2026-10-15, translated:
 * "when you check for updates and everything is fine, show a big banner
 * like 'all good', with Close").
 *
 * - A check by hand — Check now in Settings → Updates or the version panel,
 *   *Check for updates* in the palette, **Check for Updates…** in the app
 *   or tray menu — that finds nothing newer shows *You're up to date*; one
 *   that fails shows the error with **Retry**. A newer version is the
 *   existing offer's to announce, so it shows nothing here.
 * - The background check (every 15 minutes, and on focus), and Update
 *   automatically's download,
 *   never show it.
 *
 * Where it is said: in the desktop app, the status strip beside the version
 * (AppUpdateNotice, owner 2026-10-16: he looks for it bottom right); in the
 * browser dashboard, which has no strip, the banner (UpdateCheckBanner).
 *
 * `checkByHand` runs the page's own checks and reports. A check started
 * from a menu is the shell's; components/UpdateCheckBanner reads its
 * answer from the updater's phase going from checking to up to date or
 * failed, unless a check by hand or a background download is in flight.
 */
import { useSyncExternalStore } from 'react'
import { api, errText, type UpdateStatus } from './api'
import { appUpdate, appUpdateNow, newerVersion, v, type AppUpdateInfo } from './appupdate'
import { isTauri } from './appmode'

export type CheckResult =
  /** A check by hand is out (the status strip says *Checking for updates…*). */
  | { kind: 'checking'; at: number }
  | { kind: 'up_to_date'; version: string; at: number }
  | { kind: 'failed'; error: string; at: number }

let result: CheckResult | null = null
let inFlight = 0
const subs = new Set<() => void>()

function emit() { for (const f of subs) f() }

/** Show an answer (or clear it with null). */
export function reportCheck(r: CheckResult | null) {
  result = r
  emit()
}

/** A check by hand is running: the shell's phase changes are its, not a menu's. */
export function checkingByHand(): boolean { return inFlight > 0 }

/**
 * The answer, from the daemon's release check and (where the app can
 * replace itself) the app's own updater. The app's answer decides when
 * there is one: it is the version that would be installed.
 */
export function answerFor(daemon: UpdateStatus | Error, app: AppUpdateInfo | undefined, now = Date.now()): CheckResult | null {
  if (app?.supported) {
    if (app.phase === 'up_to_date') return { kind: 'up_to_date', version: v(app.version), at: now }
    if (app.phase === 'failed') return { kind: 'failed', error: app.error, at: now }
    return null
  }
  if (daemon instanceof Error) return { kind: 'failed', error: daemon.message, at: now }
  if (daemon.error) return { kind: 'failed', error: daemon.error, at: now }
  if (daemon.latest && newerVersion(daemon.latest, app?.version ?? daemon.current)) return null
  return { kind: 'up_to_date', version: v(app?.version ?? daemon.current), at: now }
}

/** Check now, as the user asked, and show the answer. Resolves to the daemon's status when it answered. */
export async function checkByHand(): Promise<UpdateStatus | undefined> {
  inFlight++
  reportCheck({ kind: 'checking', at: Date.now() })
  try {
    const app = isTauri() && appUpdateNow()?.supported ? appUpdate.check() : Promise.resolve(undefined)
    const [daemon, info] = await Promise.all([
      api.checkUpdate().catch((e: unknown) => new Error(errText(e))),
      app,
    ])
    reportCheck(answerFor(daemon, info ?? undefined))
    return daemon instanceof Error ? undefined : daemon
  } finally {
    inFlight--
  }
}

export function useCheckResult(): CheckResult | null {
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f) } },
    () => result,
    () => null,
  )
}

/** Tests only. */
export function resetCheckBanner() { result = null; inFlight = 0 }
