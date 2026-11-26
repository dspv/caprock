/**
 * Claude Code's voice failing in a terminal opened before the Caprock
 * Terminal helper (ADR-101), made one click to fix (owner-approved design,
 * 2026-11-22). After the update, new terminals answer to macOS as Caprock
 * Terminal and the microphone works; a terminal opened before it still has
 * its old `claude` process, which macOS asks about under its per-version
 * binary and which records silence. Ending that process and resuming the
 * same conversation under its own id in a new one, in the same tab, is the
 * whole fix.
 *
 * - **The matcher is two strings**, Claude Code's own failure lines:
 *   `No audio detected from microphone` and `Microphone access is denied`.
 *   Rows xterm wrapped are joined first (termupdate's logicalLines), so a
 *   narrow terminal still matches. Anything else matches nothing.
 * - **Where:** a Claude Code session Caprock started (rule 7: only its own
 *   process is stopped), in an agent tab, on a daemon running on macOS —
 *   never a shell tab, never Windows or Linux, where no helper exists.
 * - **Cheap.** Off panes never scan: the check is made before a scan is
 *   even scheduled, and a pane is on only once the daemon has said it runs
 *   on macOS. On, a scan runs at most once per VOICE_SCAN_MS over the
 *   last VOICE_SCAN_ROWS rows that have anything on them (the screen's blank
 *   bottom rows skipped), and stops once it has found the line.
 * - **The screen as it stands, when the pane turns on.** Claude Code shows
 *   the failure in its footer under the input box and keeps it there until
 *   the next recording, writing nothing after it. A pane that learns late
 *   that it is on — the page loaded with the tab open (an app update) and
 *   the terminal replayed the screen before the sessions list answered —
 *   scans once then (`rescan`): waiting for the next write waited forever
 *   (owner, 2026-11-23).
 * - **× is per session** (this browser's localStorage), and a session once
 *   restarted from the strip is not offered it again: if voice still fails
 *   after a restart, a second restart is not the cure.
 * - **Restart** is the permission-mode restart (ADR-054) in the mode the
 *   session is in now: the daemon stops the process it started and resumes
 *   the conversation with `--resume <id>` in the same folder, with its model
 *   and sign-in, and the terminal reconnects to the new process in the same
 *   tab. Only at the prompt: while the agent works, or a prompt waits on the
 *   user, the button reads *Restart when idle* and restarts once the turn is
 *   over. One session per press.
 */
import type { Terminal } from '@xterm/xterm'
import { api, type PermissionModeView } from './api'
import { logicalLines, type Row } from './termupdate'

/** How far up from the bottom of the buffer the failure line is looked for. */
export const VOICE_SCAN_ROWS = 30

/** At most one scan this often while output flows. */
export const VOICE_SCAN_MS = 500

/** How long after a failed ask for the daemon's platform it is asked again. */
export const PLATFORM_RETRY_MS = 5000

/** Claude Code's own words when its recording failed. */
export const VOICE_FAILURES = ['No audio detected from microphone', 'Microphone access is denied'] as const

/** The strip's words. */
export const VOICE_STRIP_TEXT = 'Voice works after restarting this session.'

/** Whether `rows` (top to bottom) show one of Claude Code's voice failure lines. */
export function findVoiceFailure(rows: readonly Row[], cols: number): boolean {
  return logicalLines(rows, cols).some((l) => VOICE_FAILURES.some((f) => l.text.includes(f)))
}

/**
 * Whether a pane watches for the line at all: an agent tab (not a shell), on
 * a Claude Code session Caprock started (rule 7).
 */
export function voiceTab(p: { shell: boolean; agent?: string; owned: boolean }): boolean {
  if (p.shell || !p.owned) return false
  return !p.agent || p.agent === 'claude'
}

/** Whether the daemon runs on macOS (`GET /v1/status` platform, `darwin/arm64`): the only OS with the helper. */
export function macDaemon(platform: string | undefined): boolean {
  return (platform ?? '').startsWith('darwin/') || platform === 'darwin'
}

let platform: Promise<string> | null = null

/** The daemon's platform, asked once per page (the machine the sessions run on, not the browser's). */
export function daemonPlatform(): Promise<string> {
  platform ??= api.status().then((s) => s.platform ?? '', () => { platform = null; return '' })
  return platform
}

/** Tests: forget the cached platform. */
export function resetDaemonPlatform(): void { platform = null }

/** What pressing the button does now: restart, or wait for the turn to end. */
export function restartWhen(view: Pick<PermissionModeView, 'waiting'> | null): 'now' | 'idle' {
  return view?.waiting ? 'idle' : 'now'
}

/** The mode a restart resumes in: the one the session is in now. */
export function restartMode(view: Pick<PermissionModeView, 'mode'> | null): string {
  return view?.mode || 'default'
}

const HIDDEN_KEY = 'caprock.voiceRestart.hidden'

function readHidden(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '{}') as unknown
    return v && typeof v === 'object' ? (v as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/** Whether the strip was dismissed for this session, or the session was restarted from it. */
export function isVoiceHidden(sessionId: string): boolean {
  return typeof readHidden()[sessionId] === 'number'
}

/** × on the strip, or a restart made from it: not offered again for this session. */
export function hideVoice(sessionId: string, now = Date.now()): void {
  const all = readHidden()
  all[sessionId] = now
  const kept = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, 100)
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(Object.fromEntries(kept))) } catch { /* private mode */ }
}

/**
 * Watches `term` for a voice failure line and calls `onFound` once. Nothing
 * is scanned while `enabled()` says no. Returns what to call on teardown, and
 * `rescan`: look at the screen as it stands, for when `enabled()` has turned
 * yes with the line already drawn — Claude Code writes nothing more after
 * it, so no write would bring the scan.
 */
export function attachVoiceWatch(term: Terminal, enabled: () => boolean, onFound: () => void): { dispose: () => void; rescan: () => void } {
  return attachScreenWatch(term, enabled, (rows, cols) => (findVoiceFailure(rows, cols) ? true : null), () => onFound())
}

/**
 * Watches the bottom of `term` for what `find` recognises and calls
 * `onFound` once with it. The scan is the voice watch's: at most once per
 * VOICE_SCAN_MS while output flows, over the last VOICE_SCAN_ROWS rows with
 * anything on them, never while `enabled()` says no, and it stops at the
 * first find. Shared with the guarded-folder watch (lib/termprivacy).
 */
export function attachScreenWatch<T>(
  term: Terminal,
  enabled: () => boolean,
  find: (rows: readonly Row[], cols: number) => T | null,
  onFound: (found: T) => void,
): { dispose: () => void; rescan: () => void } {
  let done = false
  let timer = 0
  let last = 0
  const scan = () => {
    timer = 0
    last = Date.now()
    if (done || !enabled()) return
    const b = term.buffer.active
    // Up to the last row with anything on it: a screen drawn from the top
    // leaves its bottom rows blank, and those are no place to look.
    let end = b.length
    const floor = Math.max(0, b.length - term.rows)
    while (end > floor && !(b.getLine(end - 1)?.translateToString(true) ?? '')) end--
    const from = Math.max(0, end - VOICE_SCAN_ROWS)
    const rows: Row[] = []
    for (let y = from; y < end; y++) {
      const line = b.getLine(y)
      rows.push({ text: line?.translateToString(false) ?? '', wrapped: !!line?.isWrapped && y > from })
    }
    const found = find(rows, term.cols)
    if (found === null) return
    done = true
    sub.dispose()
    onFound(found)
  }
  const schedule = () => {
    if (done || timer || !enabled()) return
    timer = window.setTimeout(scan, Math.max(0, VOICE_SCAN_MS - (Date.now() - last)))
  }
  const sub = term.onWriteParsed(schedule)
  return {
    rescan: schedule,
    dispose: () => {
      done = true
      if (timer) window.clearTimeout(timer)
      sub.dispose()
    },
  }
}
