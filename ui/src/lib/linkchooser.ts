/**
 * The chooser a ⇧⌘-click (Ctrl+Shift+click off macOS) on a web link in a
 * terminal opens (lib/termlinks.ts, components/LinkChooser.tsx).
 *
 * Two choices first, then Copy link (owner, 2026-10-17, translated: "I just
 * want to choose either the default browser or the built-in one"): *Default
 * browser*, named by the default's name, and *Caprock browser*, wherever a
 * browser tab can exist (the desktop app), on or off — picking it while off
 * turns the in-app browser on (lib/browsertab.ts `pickCaprock`). Every other
 * browser waits behind a quiet *Other browser…* row that expands the list in
 * place; the daemon lists only real web browsers there (internal/browser
 * known.go), never a chat app or a terminal that also handles https.
 *
 * What it lists is a list of entries, so a new kind of place to open a link
 * is one more kind here and one more case in the component.
 */
import { api, isPairedDevice, type InstalledBrowser } from './api'

export type ChooserEntry =
  /** The system's default browser, by its name when the daemon says it. */
  | { kind: 'default'; name?: string }
  /** A Caprock browser tab (ADR-075): the desktop app only. */
  | { kind: 'caprock' }
  /** Put the link on the clipboard. */
  | { kind: 'copy' }
  /** *Other browser…*: shows the other browsers in its place. */
  | { kind: 'more' }
  /** Another browser the daemon found here. */
  | { kind: 'browser'; id: string; name: string }

export interface ChooserOptions {
  /** A Caprock browser tab can exist here (the desktop app). */
  caprock?: boolean
  /** *Other browser…* was picked: the other browsers are listed. */
  expanded?: boolean
}

/**
 * The chooser's rows: the default, Caprock's own browser where it can be,
 * Copy link, then *Other browser…* — or, once picked, the other browsers in
 * its place, as the daemon sorted them. With no list (a phone, an older
 * daemon, none found) there is nothing to expand.
 */
export function chooserEntries(list: readonly InstalledBrowser[] | null, opts: ChooserOptions = {}): ChooserEntry[] {
  const def = list?.find((b) => b.default)
  const out: ChooserEntry[] = [def ? { kind: 'default', name: def.name } : { kind: 'default' }]
  if (opts.caprock) out.push({ kind: 'caprock' })
  out.push({ kind: 'copy' })
  const others = (list ?? []).filter((b) => !b.default)
  if (others.length > 0) {
    if (opts.expanded) out.push(...others.map((b): ChooserEntry => ({ kind: 'browser', id: b.id, name: b.name })))
    else out.push({ kind: 'more' })
  }
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
