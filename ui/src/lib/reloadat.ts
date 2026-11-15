/**
 * Reloads the page at `hash` (a `#/…` address). The hash goes in through
 * history.replaceState, not location.replace: in the iOS app's web view
 * (capacitor://localhost) location.replace left the address unchanged, so the
 * reload came back where it started and a scanned pairing code did nothing
 * (owner, 2026-11-15, translated: "the camera opens, scans quickly, and
 * nothing"; checked in the iOS Simulator). replaceState behaves the same in a
 * browser, where the phone's page also runs.
 */
export function reloadAt(
  hash: string,
  loc: Pick<Location, 'reload'> = window.location,
  hist: Pick<History, 'replaceState'> = window.history,
): void {
  hist.replaceState(null, '', hash)
  loc.reload()
}
