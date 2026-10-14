/**
 * The terminal's own face, JetBrains Mono, loaded on purpose and watched.
 *
 * xterm draws onto a canvas (WebGL once it is swapped in), and canvas text
 * does not load a webfont the way DOM text does. Two things went wrong
 * because of it, both seen in the app's WebKit window (2026-10-06):
 *
 * - **Glyphs from the wrong moment, kept forever.** The WebGL renderer
 *   rasterises each glyph once into a texture atlas and draws from it after.
 *   A glyph drawn while a subset of the face was still on its way — the first
 *   Russian or Greek line starts that fetch — came out in another weight, and
 *   the atlas kept it: digits, capitals and punctuation heavier and brighter
 *   than the letters beside them, for as long as the terminal lived.
 * - **A cell measured on the fallback.** xterm measures the cell once, when
 *   it opens and when the font option changes. Opened before the face
 *   arrived, it measured the fallback and kept that cell: a refit uses the
 *   measurement, it does not repeat it.
 *
 * So every subset is asked for by name before a terminal opens
 * (`loadTerminalFont`), and every terminal is told when a face finishes
 * loading (`watchTerminalFont`): it measures the cell again, throws the atlas
 * away and repaints.
 */
import type { Terminal as Xterm } from '@xterm/xterm'

/** The bundled face, as tokens.css names it at the head of --font-mono. */
export const TERMINAL_FONT_FAMILY = '"JetBrains Mono Variable"'

/**
 * One character per subset the face ships: latin, latin-ext, cyrillic,
 * cyrillic-ext, greek, vietnamese. A subset is fetched only when a character
 * in its range is asked for. CJK, Arabic, Hebrew and Thai are not in the face
 * at all; they fall through to the system monospace at the end of the stack.
 *
 * The two Cyrillic samples (U+042B, U+0462) are built at run time, through map
 * so the minifier cannot fold them back: the repository and its bundle hold no
 * Cyrillic (`make lang-check`).
 */
export function terminalFontSamples(): string[] {
  const cyrillic = [0x42b, 0x462].map((code) => String.fromCharCode(code))
  return ['A', 'ā', ...cyrillic, 'Ω', 'ế']
}

/**
 * Asks for every subset, regular and bold, and resolves once they are in (or
 * failed: the fallback still renders). Cheap to call again: the browser keeps
 * one request per face.
 */
export function loadTerminalFont(fonts: FontFaceSet | undefined = typeof document === 'undefined' ? undefined : document.fonts): Promise<void> {
  if (!fonts?.load) return Promise.resolve()
  const asks: Promise<unknown>[] = []
  for (const sample of terminalFontSamples()) {
    for (const weight of ['400', '700']) {
      asks.push(fonts.load(`${weight} 13px ${TERMINAL_FONT_FAMILY}`, sample).catch(() => []))
    }
  }
  return Promise.all(asks).then(() => undefined)
}

/** Every terminal in the page, while its font watcher runs (watchTerminalFont). */
const liveTerms = new Map<Xterm, () => void>()

/**
 * Throws the WebGL glyph atlas away and has EVERY terminal draw from the new
 * one — never one terminal alone.
 *
 * xterm's WebGL addon shares one atlas among all terminals with the same face,
 * size, colours and pixel ratio, and `clearTextureAtlas()` empties that shared
 * atlas but forgets the cell model of the terminal it was called on only. The
 * others kept, for every cell they had not redrawn since, the atlas position
 * of a glyph that was no longer there: the next glyphs rasterised into those
 * positions showed up in their place. Rows redrawn in full were right, rows
 * partly redrawn read as garbage ("ι ɤr ·r ɤrrง") — for good, in a tab that
 * did not print, or for the 2 s until Claude Code's status rows were drawn
 * again (owner, 2026-10-14, after closing a tab and after the chat). Any one
 * terminal clearing it — a tab back after five minutes, a wake, a pixel-ratio
 * change, a face finishing its load — did it to all the rest.
 *
 * So each terminal clears its model in the same task, before any of them
 * draws: the first call empties the atlas, the rest find it empty and only
 * clear their models (the addon's `clearTexture` does nothing on an empty
 * atlas). A hidden terminal repaints in full when it is next shown.
 */
export function clearGlyphAtlas(term?: Xterm): void {
  const all = new Set(liveTerms.keys())
  if (term) all.add(term)
  for (const t of all) {
    try {
      t.clearTextureAtlas()
      t.refresh(0, t.rows - 1)
    } catch { /* disposed */ }
  }
}

/**
 * Makes a terminal measure its cell again and redraw every glyph. xterm
 * measures only when fontFamily or fontSize changes, so the family is set to
 * a generic one and back; the WebGL atlas is cleared (for every terminal:
 * clearGlyphAtlas) so no glyph rasterised before now survives.
 */
export function remeasureTerminal(term: Xterm): void {
  const family = term.options.fontFamily
  term.options.fontFamily = 'monospace'
  term.options.fontFamily = family
  clearGlyphAtlas(term)
}

/**
 * Re-measures and repaints `term` whenever a face finishes loading — the
 * bundled one or any other the stack names — at most once a frame, and once
 * when the faces asked for by `loadTerminalFont` are in. `after` runs after
 * each re-measure (a fit: a new cell is a new column count). Returns the stop.
 */
/**
 * The cell's width over the font size, as xterm measured it: about 0.6 for
 * any monospace face. Undefined while there is no measurement (a pane never
 * laid out, `display: none`, another xterm without these insides).
 */
export function cellRatio(term: Xterm): number | undefined {
  const cell = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } } } })._core?._renderService?.dimensions?.css?.cell
  const size = Number(term.options.fontSize) || 0
  if (!cell?.width || !size) return undefined
  return cell.width / size
}

/**
 * A cell no monospace face draws: wider than 0.9 of the font size or
 * narrower than 0.4 (letterSpacing is always 0 here). The owner, after an
 * update restarted the app (2026-10-14): every glyph in a cell about three
 * times too wide, unreadable, until font size + then − made xterm measure
 * again. xterm measures only when it opens and when the face or size option
 * changes, so a measurement taken while the webview was still settling was
 * kept for good.
 */
export function implausibleCell(ratio: number | undefined): boolean {
  return ratio !== undefined && (ratio > 0.9 || ratio < 0.4)
}

/**
 * Has a watched terminal check its cell a couple of frames from now (a pane
 * just shown or refitted: hidden, it had nothing to measure). A no-op for a
 * terminal not watched.
 */
export function checkTerminalCell(term: Xterm): void {
  liveTerms.get(term)?.()
}

/** Re-measures in a row, at most, while the cell stays implausible. */
export const MAX_CELL_RETRIES = 5

export function watchTerminalFont(term: Xterm, after: () => void = () => {}, fonts: FontFaceSet | undefined = typeof document === 'undefined' ? undefined : document.fonts): () => void {
  let stopped = false
  let raf = 0
  const redo = () => {
    raf = 0
    if (stopped) return
    try {
      remeasureTerminal(term)
      after()
    } catch { /* disposed or not laid out */ }
  }
  const schedule = () => {
    if (!stopped && !raf) raf = requestAnimationFrame(redo)
  }
  // The guard: a cell no monospace face draws is measured again on the next
  // frame, a few times at most; a plausible one resets the count.
  let retries = 0
  let verifyRaf = 0
  const verify = () => {
    verifyRaf = 0
    if (stopped) return
    let ratio: number | undefined
    try { ratio = cellRatio(term) } catch { return }
    if (!implausibleCell(ratio)) { retries = 0; return }
    if (retries >= MAX_CELL_RETRIES) return
    retries++
    schedule()
    verifyLater()
  }
  const verifyLater = () => {
    if (!stopped && !verifyRaf) verifyRaf = requestAnimationFrame(() => { verifyRaf = requestAnimationFrame(verify) })
  }
  // Back into view (the app restarted into an update, a wake): look again.
  liveTerms.set(term, verifyLater)
  const onVisible = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') verifyLater() }
  // Only a face the terminal's stack names is a reason: the dashboard's own
  // sans loading is not.
  const onLoaded = (e: Event) => {
    const faces = (e as FontFaceSetLoadEvent).fontfaces
    const stack = String(term.options.fontFamily ?? '').toLowerCase()
    if (faces && faces.length > 0 && !faces.some((f) => stack.includes(f.family.replace(/["']/g, '').toLowerCase()))) return
    schedule()
    verifyLater()
  }
  // Already in (the usual case after the first terminal): nothing to redo.
  const ready = terminalFontSamples().every((s) => {
    try { return fonts?.check?.(`13px ${TERMINAL_FONT_FAMILY}`, s) === true } catch { return false }
  })
  if (!ready) loadTerminalFont(fonts).then(schedule)
  // Every face the page asked for is in (or failed): check what was measured.
  void fonts?.ready?.then(verifyLater, () => {})
  verifyLater()
  fonts?.addEventListener?.('loadingdone', onLoaded)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  return () => {
    stopped = true
    liveTerms.delete(term)
    if (raf) cancelAnimationFrame(raf)
    if (verifyRaf) cancelAnimationFrame(verifyRaf)
    fonts?.removeEventListener?.('loadingdone', onLoaded)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
  }
}
