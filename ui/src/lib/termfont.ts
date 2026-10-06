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

/**
 * Makes a terminal measure its cell again and redraw every glyph. xterm
 * measures only when fontFamily or fontSize changes, so the family is set to
 * a generic one and back; the WebGL atlas is cleared so no glyph rasterised
 * before now survives.
 */
export function remeasureTerminal(term: Xterm): void {
  const family = term.options.fontFamily
  term.options.fontFamily = 'monospace'
  term.options.fontFamily = family
  term.clearTextureAtlas()
  term.refresh(0, term.rows - 1)
}

/**
 * Re-measures and repaints `term` whenever a face finishes loading — the
 * bundled one or any other the stack names — at most once a frame, and once
 * when the faces asked for by `loadTerminalFont` are in. `after` runs after
 * each re-measure (a fit: a new cell is a new column count). Returns the stop.
 */
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
  // Only a face the terminal's stack names is a reason: the dashboard's own
  // sans loading is not.
  const onLoaded = (e: Event) => {
    const faces = (e as FontFaceSetLoadEvent).fontfaces
    const stack = String(term.options.fontFamily ?? '').toLowerCase()
    if (faces && faces.length > 0 && !faces.some((f) => stack.includes(f.family.replace(/["']/g, '').toLowerCase()))) return
    schedule()
  }
  // Already in (the usual case after the first terminal): nothing to redo.
  const ready = terminalFontSamples().every((s) => {
    try { return fonts?.check?.(`13px ${TERMINAL_FONT_FAMILY}`, s) === true } catch { return false }
  })
  if (!ready) loadTerminalFont(fonts).then(schedule)
  fonts?.addEventListener?.('loadingdone', onLoaded)
  return () => {
    stopped = true
    if (raf) cancelAnimationFrame(raf)
    fonts?.removeEventListener?.('loadingdone', onLoaded)
  }
}
