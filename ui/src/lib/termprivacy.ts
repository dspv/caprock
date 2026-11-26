/**
 * A session macOS refused a guarded folder, made one click from the fix
 * (ADR-106). On 0.197.0 sessions in Caprock terminals were refused
 * ~/Downloads with `Operation not permitted` and no prompt, and nothing said
 * where the switch was. When a terminal shows that refusal for one of the
 * folders macOS guards, a strip under it names the folder and the entry to
 * switch on — the program macOS asks about, as System Settings lists it
 * (`GET /v1/sessions/{id}/privacy`: "Caprock Terminal", or a Claude Code
 * version for a session from before the helper) — with **Open Settings**,
 * which opens System Settings › Privacy & Security › Full Disk Access on
 * this Mac and shows the program in Finder, and ×.
 *
 * - **The matcher** wants both on one logical line (wrapped rows joined):
 *   the refusal — `Operation not permitted` or `EPERM`, as `ls`, `cat` and
 *   Node print it — and a path into a guarded place: `~/` or `/Users/<name>/`
 *   followed by Desktop, Documents or Downloads, iCloud Drive
 *   (`Library/Mobile Documents`), cloud storage (`Library/CloudStorage`) or
 *   a volume under `/Volumes/`. `Permission denied` (EACCES, the file's own
 *   mode) is not macOS privacy and matches nothing.
 * - **Where:** every terminal tab, agent or shell, on a daemon running on
 *   macOS; never Windows or Linux. Nothing is stopped or typed: the button
 *   only opens a pane, and only on a click.
 * - **Cheap:** the voice watch's scan (lib/termvoice attachScreenWatch), off
 *   until the daemon has said it runs on macOS, stopping at the first find.
 * - **× is per session** (this browser's localStorage).
 */
import type { Row } from './termupdate'
import { logicalLines } from './termupdate'

/** The refusal, as `ls`/`cat` (`Operation not permitted`) and Node (`EPERM`) print it. */
const REFUSED = /operation not permitted|\bEPERM\b/i

/** A path into a guarded place; group 1 a home folder, else the rest names it. */
const GUARDED = /(?:~|\/Users\/[^/\s'"`]+)\/(Desktop|Documents|Downloads)(?![^/\s'"`):,.])|\/Library\/(Mobile Documents|CloudStorage)\/|\/Volumes\/[^/\s'"`]/

/** The folder a refusal names, as the strip says it. */
export type GuardedFolder = 'Desktop' | 'Documents' | 'Downloads' | 'iCloud Drive' | 'cloud storage' | 'a drive'

/** The folder of the first line in `rows` that shows macOS refusing a guarded place, or null. */
export function findPrivacyRefusal(rows: readonly Row[], cols: number): GuardedFolder | null {
  for (const l of logicalLines(rows, cols)) {
    if (!REFUSED.test(l.text)) continue
    const m = GUARDED.exec(l.text)
    if (!m) continue
    if (m[1]) return m[1] as GuardedFolder
    if (m[2] === 'Mobile Documents') return 'iCloud Drive'
    if (m[2] === 'CloudStorage') return 'cloud storage'
    return 'a drive'
  }
  return null
}

/** The strip's sentence: what was refused and exactly where to allow it. */
export function privacyText(folder: GuardedFolder, name: string): string {
  const who = name || 'the program in this terminal'
  return `macOS kept this session out of ${folder}. Allow ${who} in System Settings › Privacy & Security › Full Disk Access (or Files & Folders).`
}

const HIDDEN_KEY = 'caprock.privacyStrip.hidden'

function readHidden(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '{}') as unknown
    return v && typeof v === 'object' ? (v as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/** Whether × was pressed on this session's strip. */
export function isPrivacyHidden(sessionId: string): boolean {
  return typeof readHidden()[sessionId] === 'number'
}

/** × on the strip: not offered again for this session. */
export function hidePrivacy(sessionId: string, now = Date.now()): void {
  const all = readHidden()
  all[sessionId] = now
  const kept = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, 100)
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(Object.fromEntries(kept))) } catch { /* private mode */ }
}
