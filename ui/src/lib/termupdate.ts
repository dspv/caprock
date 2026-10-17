/**
 * An agent's "update available" notice in a terminal, made easy to act on
 * (owner, 2026-10-17, translated: "I'd update, but it's inconvenient to even
 * copy the line. Let's at least: copy it and open a terminal next to it —
 * simple, I'll do it myself"). TerminalPane shows a small bar near the
 * terminal's bottom: *Codex 0.162.0 available · Copy command · Open a
 * terminal · ×*.
 *
 * - **Nothing printed is ever run.** The command is only put on the
 *   clipboard; *Open a terminal* opens a plain shell tab in the session's
 *   folder and types nothing into it. The user pastes and presses Enter.
 * - **A small, explicit matcher.** Codex: a row `Update available! A -> B`,
 *   then within a few rows `Run <command> to update.`, the command containing
 *   `codex`. Claude Code: `Update available! Run: <command>` or `Auto-update
 *   failed · Try claude doctor or <command>`, the command containing
 *   `claude`. Anything else matches nothing.
 * - **Wrapped lines come back whole.** Rows xterm wrapped (`isWrapped`) are
 *   joined as they are; rows the agent wrapped itself (Codex word-wraps its
 *   history, inside a `│` box or not) are joined with a space, or without one
 *   where the row was filled to its edge — a long word broken mid-way.
 * - **Cheap.** Run on parsed write batches (xterm's onWriteParsed), at most
 *   once per UPDATE_SCAN_MS, over the last UPDATE_SCAN_ROWS rows; it stops
 *   once it has found a notice.
 * - **× is per agent and version** (this browser's localStorage). A notice
 *   with no version (Claude Code's) is dismissed for DISMISS_UNVERSIONED_MS.
 */
import type { Terminal } from '@xterm/xterm'

/** How far up from the bottom of the buffer a notice is looked for. */
export const UPDATE_SCAN_ROWS = 30

/** At most one scan this often while output flows. */
export const UPDATE_SCAN_MS = 500

/** A notice without a version stays dismissed this long. */
export const DISMISS_UNVERSIONED_MS = 24 * 60 * 60_000

/** A command longer than this is not taken for one. */
const MAX_COMMAND = 400

export type UpdateAgent = 'codex' | 'claude'

export interface UpdateNotice {
  agent: UpdateAgent
  /** The version on offer, when the notice names it. */
  version?: string
  /** The exact command text, as printed: only ever copied, never run. */
  command: string
}

/** One buffer row: its text untrimmed, and whether xterm wrapped it onto the row above. */
export interface Row {
  text: string
  wrapped: boolean
}

const AGENT_NAME: Record<UpdateAgent, string> = { codex: 'Codex', claude: 'Claude Code' }

/** The bar's words: "Codex 0.162.0 available", "Claude Code update available". */
export function noticeLabel(n: UpdateNotice): string {
  return n.version ? `${AGENT_NAME[n.agent]} ${n.version} available` : `${AGENT_NAME[n.agent]} update available`
}

const BORDER = /[│┃]/
const CODEX_HEAD = /Update available!\s+v?(\d[\w.+-]*)\s+->\s+v?(\d[\w.+-]*)/
const CODEX_RUN = /^Run\s+(.*)$/
const CODEX_TAIL = /\s+to update\.?$/
const CLAUDE_RUN = /Update available!\s+Run:\s+(.+)$/
const CLAUDE_FAILED = /Auto-update failed\s+·\s+Try claude doctor or\s+(.+)$/

/** A logical line: xterm's wrapped rows joined, a box's borders off, and whether it was filled to its edge. */
interface Line { text: string; full: boolean }

/** Rows → logical lines: soft-wrapped rows joined, `│` borders stripped. */
export function logicalLines(rows: readonly Row[], cols: number): Line[] {
  const out: Line[] = []
  for (let i = 0; i < rows.length; i++) {
    let raw = rows[i]!.text
    // A row xterm wrapped onto the next: the untrimmed text, so a space at the break survives.
    while (i + 1 < rows.length && rows[i + 1]!.wrapped) raw = raw.padEnd(cols) + rows[++i]!.text
    out.push(contentOf(raw, cols))
  }
  return out
}

function contentOf(raw: string, cols: number): Line {
  const trimmed = raw.replace(/\s+$/, '')
  let s = trimmed
  let full = false
  const left = /^\s*[│┃]\s?/.exec(s)
  if (left) s = s.slice(left[0].length)
  if (BORDER.test(s.slice(-1))) {
    // A box: filled to its edge when the text runs up to the pad before the border.
    const r = raw.lastIndexOf(s.slice(-1))
    const end = raw.slice(0, r).replace(/\s+$/, '').length
    full = r - end <= 1
    s = s.slice(0, -1)
  } else {
    full = trimmed.length >= cols
  }
  return { text: s.trim(), full }
}

/**
 * Whether the row before a continuation was cut mid-word, so the two join
 * with no space. Greedy wrapping (textwrap's, Codex's) starts a word longer
 * than the width on a row of its own and breaks it there, so such a row is
 * one word that runs to its edge (the terminal's, or its box's) or is as long
 * as the longest row of the block. A row of several words ended between them.
 */
function cutMidWord(row: Line, next: Line, longest: number): boolean {
  // A word exactly as long as the width looks the same; one followed by a
  // shell operator was a whole word (a URL piped into `sh`).
  if (/^[|&;<>]/.test(next.text)) return false
  return !/\s/.test(row.text) && (row.full || row.text.length >= longest)
}

/** The command text cleaned: backticks around it off, and only a plausible one kept. */
function cleanCommand(raw: string): string | null {
  let c = raw.trim()
  const tick = /^`([^`]+)`$/.exec(c)
  if (tick) c = tick[1]!.trim()
  if (!c || c.length > MAX_COMMAND) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(c)) return null
  return c
}

/**
 * The most recent update notice among `rows` (top to bottom), or null. The
 * text is read, never run.
 */
export function findUpdateNotice(rows: readonly Row[], cols: number): UpdateNotice | null {
  const lines = logicalLines(rows, cols)
  let found: UpdateNotice | null = null
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.text
    // The header itself wrapped on a narrow terminal: a version on the next row.
    let head = CODEX_HEAD.exec(t)
    const split = !head && /Update available!/.test(t) && i + 1 < lines.length
    if (split) head = CODEX_HEAD.exec(`${t} ${lines[i + 1]!.text}`)
    if (head) {
      const n = codexAt(lines, split ? i + 1 : i, head[2]!)
      if (n) found = n
      continue
    }
    const run = CLAUDE_RUN.exec(t) ?? CLAUDE_FAILED.exec(t)
    if (run) {
      const command = cleanCommand(run[1]!)
      if (command && /claude/i.test(command)) found = { agent: 'claude', command }
    }
  }
  return found
}

/** Codex's `Run <command> to update.` under its header at `i`, joined across the rows it wrapped onto. */
function codexAt(lines: readonly Line[], i: number, version: string): UpdateNotice | null {
  for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
    const m = CODEX_RUN.exec(lines[j]!.text)
    if (!m) continue
    // The rows up to the one that ends the sentence…
    // (`to update.` may itself be split over two rows).
    let k = j
    let seen = lines[j]!.text
    while (!CODEX_TAIL.test(seen) && k + 1 < lines.length && k < j + 8) seen += ` ${lines[++k]!.text}`
    const block = lines.slice(j, k + 1)
    const longest = Math.max(...block.map((l) => l.text.length))
    // …joined, with a space where the agent wrapped between words.
    let acc = m[1]!
    for (let r = 1; r < block.length; r++) {
      const b = block[r]!
      if (b.text) acc = cutMidWord(block[r - 1]!, b, longest) ? acc + b.text : `${acc} ${b.text}`
    }
    if (!CODEX_TAIL.test(acc)) return null
    const command = cleanCommand(acc.replace(CODEX_TAIL, ''))
    if (!command || !/codex/i.test(command)) return null
    return { agent: 'codex', version, command }
  }
  return null
}

const DISMISSED_KEY = 'caprock.updateNotice.dismissed'

/** What × remembers: the agent and the version, or the command when there is no version. */
export function dismissKey(n: UpdateNotice): string {
  return n.version ? `${n.agent}@${n.version}` : `${n.agent}:${n.command}`
}

function readDismissed(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '{}') as unknown
    return v && typeof v === 'object' ? (v as Record<string, number>) : {}
  } catch {
    return {}
  }
}

export function isDismissed(n: UpdateNotice, now = Date.now()): boolean {
  const at = readDismissed()[dismissKey(n)]
  if (typeof at !== 'number') return false
  return n.version ? true : now - at < DISMISS_UNVERSIONED_MS
}

export function dismissNotice(n: UpdateNotice, now = Date.now()): void {
  const all = readDismissed()
  all[dismissKey(n)] = now
  // The newest 50 are plenty.
  const kept = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, 50)
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(Object.fromEntries(kept))) } catch { /* private mode */ }
}

/**
 * Watches `term` for an update notice and calls `onNotice` once with the
 * first one not dismissed. Returns what to call on teardown.
 */
export function attachUpdateWatch(term: Terminal, onNotice: (n: UpdateNotice) => void): { dispose: () => void } {
  let done = false
  let timer = 0
  let last = 0
  const scan = () => {
    timer = 0
    last = Date.now()
    if (done) return
    const b = term.buffer.active
    if (b.type !== 'normal') return
    const end = b.length
    const from = Math.max(0, end - UPDATE_SCAN_ROWS)
    const rows: Row[] = []
    for (let y = from; y < end; y++) {
      const line = b.getLine(y)
      rows.push({ text: line?.translateToString(false) ?? '', wrapped: !!line?.isWrapped && y > from })
    }
    const n = findUpdateNotice(rows, term.cols)
    if (!n) return
    done = true
    sub.dispose()
    if (!isDismissed(n)) onNotice(n)
  }
  const sub = term.onWriteParsed(() => {
    if (done || timer) return
    timer = window.setTimeout(scan, Math.max(0, UPDATE_SCAN_MS - (Date.now() - last)))
  })
  return {
    dispose: () => {
      done = true
      if (timer) window.clearTimeout(timer)
      sub.dispose()
    },
  }
}

/** Asks the workspace for a plain shell tab in `sessionId`'s folder (AppShell); nothing is typed into it. */
export const OPEN_SHELL_BESIDE_EVENT = 'caprock:open-shell-beside'

export function requestShellBeside(sessionId: string): void {
  window.dispatchEvent(new CustomEvent<{ sessionId: string }>(OPEN_SHELL_BESIDE_EVENT, { detail: { sessionId } }))
}
