/**
 * The browser chooser a ⇧⌘-click (Ctrl+Shift+click off macOS) on a web link
 * in a terminal opens (lib/termlinks.ts, components/LinkChooser.tsx; owner,
 * 2026-10-17, translated: "Cmd+click is the default … I want another chord,
 * and there I see and choose which browser to open it in").
 *
 * What it lists is a list of entries, so a new kind of place to open a link
 * is one more kind here and one more case in the component. The in-app
 * browser (the Page tab) was withdrawn in 0.124.1 after WebKit crashes
 * (ADR-070); "Open in Caprock" comes back as `{ kind: 'caprock' }` the day it
 * does, and not before.
 */
import { api, isPairedDevice, type InstalledBrowser } from './api'

export type ChooserEntry =
  /** A browser the daemon found here; `isDefault` is the system's default. */
  | { kind: 'browser'; id: string; name: string; isDefault: boolean }
  /** The system's default browser, when the list does not say which it is. */
  | { kind: 'system' }
  /** Put the link on the clipboard. */
  | { kind: 'copy' }

/**
 * The chooser's rows: the browsers, the default first (the daemon sorts
 * them, and this keeps it so), then Copy link. With no list (a phone, an
 * older daemon, none found) or none marked default, the system's default
 * comes first, so the chooser can always do what ⌘-click does.
 */
export function chooserEntries(list: readonly InstalledBrowser[] | null): ChooserEntry[] {
  const bs = [...(list ?? [])].sort((a, b) => Number(b.default) - Number(a.default))
  const out: ChooserEntry[] = bs.map((b) => ({ kind: 'browser', id: b.id, name: b.name, isDefault: b.default }))
  if (!bs.some((b) => b.default)) out.unshift({ kind: 'system' })
  out.push({ kind: 'copy' })
  return out
}

let cached: Promise<InstalledBrowser[] | null> | null = null

/** The browsers installed here, asked once per page; null on a phone or when the daemon cannot say. */
export function loadBrowsers(): Promise<InstalledBrowser[] | null> {
  if (isPairedDevice()) return Promise.resolve(null)
  if (!cached) {
    cached = api.browsers().then((r) => r.browsers, () => {
      cached = null
      return null
    })
  }
  return cached
}

/** Forget the list (tests). */
export function resetBrowsers(): void {
  cached = null
}
