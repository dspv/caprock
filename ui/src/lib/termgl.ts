/**
 * A terminal's WebGL context, watched so it is never drawn on once gone.
 *
 * xterm's WebGL addon (0.19), told its context is lost, waits three seconds
 * for the browser to restore it and only then reports the loss
 * (`onContextLoss`), which is when Caprock swapped the renderer. Through
 * those seconds every frame of output went to a dead canvas, so the screen
 * kept what it showed at the loss while the session went on printing:
 * Claude Code's live subagent list stuck at a row count it had long left.
 * And a context WebKit lets go without the event (as it lets a hidden
 * canvas's texture go, #541) was never reported at all: the terminal stayed
 * frozen until Caprock restarted. When the browser does restore it, the
 * addon rebuilds in place, and in WebKit that deletes the old context's
 * objects through the new one, a WebGL error in the console for each
 * (Playwright's WebKit, 2026-10-20).
 *
 * So the loss is acted on at once (`watchContextLoss`), and a context that
 * went silently is found by asking (`contextGone`) wherever the terminal is
 * looked at again or writes. The caller drops the addon, which puts xterm's
 * DOM renderer in its place in the same frame, and makes a new one later.
 */

type WithGl = { _renderer?: { _gl?: WebGLRenderingContext | WebGL2RenderingContext; _canvas?: HTMLCanvasElement } }

/** The addon's context and canvas, when its insides are what this expects. */
function insides(addon: unknown): { gl?: WebGLRenderingContext | WebGL2RenderingContext; canvas?: HTMLCanvasElement } {
  const r = (addon as WithGl | null | undefined)?._renderer
  return { gl: r?._gl, canvas: r?._canvas }
}

/**
 * Whether the addon draws with a context that is gone. False when it cannot
 * tell (another addon version): the addon's own report still comes then.
 */
export function contextGone(addon: unknown): boolean {
  const { gl } = insides(addon)
  try { return !!gl && typeof gl.isContextLost === 'function' && gl.isContextLost() } catch { return false }
}

/**
 * Disposes the addon and gives its context back to the GPU now.
 *
 * The addon's own dispose takes its canvas out of the page and nothing more:
 * the context, and the drawing buffers WebKit keeps for it (the pane's size
 * at the screen's pixel ratio, about 20 MB of the window's graphics memory
 * for a full pane, measured 2026-10-28), stay until the canvas is collected.
 * `WEBGL_lose_context` lets them go at once. Safe on a context already lost,
 * and on an addon whose insides are not what this expects.
 */
export function disposeWebgl(addon: { dispose: () => void } | undefined): void {
  if (!addon) return
  const { gl } = insides(addon)
  try { addon.dispose() } catch { /* already gone */ }
  try {
    if (gl && typeof gl.isContextLost === 'function' && !gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext()
  } catch { /* nothing to give back */ }
}

/**
 * Calls `lost` once, the moment the addon's canvas loses its context — not
 * three seconds later — and keeps it from the addon's in-place restore.
 * Returns the stop. A no-op stop when the canvas cannot be found.
 */
export function watchContextLoss(addon: unknown, lost: () => void): () => void {
  const { canvas } = insides(addon)
  if (!canvas || typeof canvas.addEventListener !== 'function') return () => {}
  let fired = false
  const on = () => {
    if (fired) return
    fired = true
    lost()
  }
  canvas.addEventListener('webglcontextlost', on)
  return () => canvas.removeEventListener('webglcontextlost', on)
}
