/**
 * A faint band behind Claude Code's input box in the terminal (owner,
 * 2026-10-15, translated: "a light, slight highlight of the input field, one
 * that doesn't draw much attention"). Claude Code draws where you type as a
 * `❯` prompt between two horizontal rules; in a long, dense screen it is
 * hard to find. The rows between the rules get the terminal's own background
 * lifted a step toward its ink — 5% on a light palette, 7% on a dark one,
 * where 5% all but vanished in a preview — and nothing else changes.
 *
 * - **Only what it is sure of.** The box is a rule, a prompt row (`❯`, `>`,
 *   `!` or `#` and a space, never a numbered menu row), then rows up to the
 *   next rule. Anything else — another agent, a shell, a permission dialog,
 *   a Claude Code that draws its box differently — finds nothing, and
 *   nothing is drawn.
 * - **Cheap.** Run once per parsed write batch (xterm's onWriteParsed), it
 *   reads only the last BOX_SCAN_ROWS rows of the buffer, a few cells of
 *   each until a rule turns up; the decorations are re-registered only when
 *   the box moved, grew or changed colour.
 * - **Never over other content.** Decorations, which xterm paints under the
 *   text and the selection, on cells with the default background only: a
 *   cell Claude Code coloured itself or drew in inverse (its cursor) keeps
 *   its colours. Anchored to buffer lines, the band scrolls with the box.
 * - **Yours to switch off.** Settings → Terminal → *Highlight where you
 *   type*, or ⌥⌘G from anywhere (owner, 2026-10-17, translated: "a toggle to
 *   turn the input field highlight on/off"): hidden, the box is still found,
 *   so pointing at it can say which key brings the band back (`boxRows`).
 *   *Stronger* lifts the ground further (BOX_LIFT).
 */
import type { IBufferCell, IBufferLine, IDecoration, IMarker, Terminal } from '@xterm/xterm'
import { mixHex } from './termthemes'

/** How far up from the bottom of the buffer the box is looked for. */
export const BOX_SCAN_ROWS = 40

/** A box taller than this (rows between the rules) is not taken for one. */
export const BOX_MAX_ROWS = 30

/** How far the band lifts the terminal's background toward its ink, on a light and a dark palette, at each strength. */
export const BOX_LIFT = {
  subtle: { light: 0.05, dark: 0.07 },
  stronger: { light: 0.09, dark: 0.12 },
} as const

export type BoxStrength = keyof typeof BOX_LIFT

const RULE = '─'
const PROMPT = /^ {0,2}[❯>!#](?: |$)/
const MENU_ROW = /^ {0,2}[❯>] +\d+\./

/** A horizontal rule as Claude Code draws one: at least half the width of `─`. */
export function isRuleText(text: string, cols: number): boolean {
  const t = text.trimStart()
  if (!t.startsWith(RULE.repeat(3)) || text.length - t.length > 2) return false
  let n = 0
  for (const ch of t) if (ch === RULE) n++
  return n >= Math.max(8, cols / 2)
}

/** The prompt row right under the box's top rule. */
export function isPromptText(text: string): boolean {
  return PROMPT.test(text) && !MENU_ROW.test(text)
}

/**
 * The rows inside the input box, as indexes into `text` (top to bottom), or
 * null. `text(i)` is row i's text, right-trimmed; rows are read from the last
 * up, and only as far as the box needs.
 */
export function findInputBox(text: (i: number) => string, count: number, cols: number): { first: number; last: number } | null {
  let bottom = -1
  for (let i = count - 1; i >= 0; i--) {
    if (isRuleText(text(i), cols)) { bottom = i; break }
  }
  if (bottom < 1) return null
  for (let i = bottom - 1; i >= 0 && bottom - i - 1 <= BOX_MAX_ROWS; i--) {
    if (!isRuleText(text(i), cols)) continue
    // The rule above: the box is what lies between, and starts with the prompt.
    if (i === bottom - 1 || !isPromptText(text(i + 1))) return null
    return { first: i + 1, last: bottom - 1 }
  }
  return null
}

/** A run of cells with the default background on one buffer row. */
interface Run { y: number; x: number; width: number; height: number }

/** The default-background runs of the box's rows, adjacent equal rows merged. */
export function boxRuns(lineAt: (y: number) => IBufferLine | undefined, first: number, last: number, cols: number): Run[] {
  const out: Run[] = []
  let cell: IBufferCell | undefined
  for (let y = first; y <= last; y++) {
    const line = lineAt(y)
    if (!line) return []
    const row: Run[] = []
    let start = -1
    for (let x = 0; x <= cols; x++) {
      cell = x < cols ? line.getCell(x, cell) : undefined
      const plain = !!cell && cell.isBgDefault() && !cell.isInverse()
      if (plain && start < 0) start = x
      if (!plain && start >= 0) {
        row.push({ y, x: start, width: x - start, height: 1 })
        start = -1
      }
    }
    // A row the same as the one above lengthens that band.
    const prev = out.filter((r) => r.y + r.height === y)
    if (prev.length === row.length && prev.every((r, i) => r.x === row[i]!.x && r.width === row[i]!.width)) {
      for (const r of prev) r.height++
    } else {
      out.push(...row)
    }
  }
  return out
}

/** The band's colour on a theme, or '' when the theme's colours are not #rrggbb. */
export function boxColor(background?: string, foreground?: string, strength: BoxStrength = 'subtle'): string {
  const hex = /^#[0-9a-f]{6}$/i
  if (!background || !foreground || !hex.test(background) || !hex.test(foreground)) return ''
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16))
  const light = 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 128
  const lift = BOX_LIFT[strength]
  return mixHex(background, foreground, light ? lift.light : lift.dark)
}

export interface InputBoxBand {
  /** Looks for the box again: after a write is parsed, a resize, a theme change. */
  update: () => void
  /** On for a Claude Code session, off (and cleared) for anything else. */
  setEnabled: (on: boolean) => void
  /** The user's switch: drawn or not (the box is still looked for), and how strong. */
  setLook: (look: { shown: boolean; strength: BoxStrength }) => void
  /** The box's rows as buffer lines (first, last), while enabled and found; null otherwise. */
  boxRows: () => { first: number; last: number } | null
  dispose: () => void
}

/** Keeps the band on `term`'s input box. Starts off; setEnabled(true) turns it on. */
export function attachInputBoxBand(term: Terminal): InputBoxBand {
  let enabled = false
  let shown = true
  let strength: BoxStrength = 'subtle'
  let found: { first: number; last: number } | null = null
  let key = ''
  let drawn: { marker: IMarker; deco?: IDecoration }[] = []

  const clear = () => {
    for (const d of drawn) {
      d.deco?.dispose()
      d.marker.dispose()
    }
    drawn = []
    key = ''
  }

  const update = () => {
    if (!enabled) return
    const b = term.buffer.active
    if (b.type !== 'normal') { found = null; clear(); return }
    const cols = term.cols
    const end = b.length
    const from = Math.max(0, end - BOX_SCAN_ROWS)
    const box = findInputBox((i) => b.getLine(from + i)?.translateToString(true) ?? '', end - from, cols)
    found = box ? { first: from + box.first, last: from + box.last } : null
    if (!shown) { if (key) clear(); return }
    const theme = term.options.theme
    const color = boxColor(theme?.background, theme?.foreground, strength)
    if (!box || !color) { if (key) clear(); return }
    const runs = boxRuns((y) => b.getLine(y), from + box.first, from + box.last, cols)
    const next = `${color}|${runs.map((r) => `${r.y},${r.x},${r.width},${r.height}`).join(';')}`
    // Unchanged, and still standing (a trimmed or reset line takes its marker along).
    if (next === key && drawn.every((d) => !d.marker.isDisposed)) return
    clear()
    const cursor = b.baseY + b.cursorY
    for (const r of runs) {
      const marker = term.registerMarker(r.y - cursor)
      if (!marker) continue
      const deco = term.registerDecoration({ marker, x: r.x, width: r.width, height: r.height, backgroundColor: color, layer: 'bottom' })
      // The element xterm places over the rows must not take the mouse.
      deco?.onRender((el) => { el.style.pointerEvents = 'none' })
      drawn.push({ marker, deco })
    }
    key = next
  }

  return {
    update,
    setEnabled: (on) => {
      if (on === enabled) return
      enabled = on
      if (on) update()
      else { found = null; clear() }
    },
    setLook: (look) => {
      if (look.shown === shown && look.strength === strength) return
      shown = look.shown
      strength = look.strength
      if (!shown) clear()
      update()
    },
    boxRows: () => (enabled ? found : null),
    dispose: () => {
      enabled = false
      found = null
      clear()
    },
  }
}
