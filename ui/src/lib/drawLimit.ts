/**
 * How long drawing a share picture may take before the sheet gives up and
 * says so (.ai/04-ui.md § Share).
 *
 * Every share button waits on a promise it does not own: the figures from
 * the daemon, the fonts, html-to-image's own image decode. One that never
 * settled left the share sheet on "Drawing…" with every button disabled
 * (owner, 2026-10-31, in the app: Threads on *this month*). Past the limit
 * the button is released and one plain line says to try again; whatever was
 * still running is left to finish on its own and its result is dropped.
 */

/** The longest a share picture may take to draw, figures included. */
export const DRAW_LIMIT_MS = 30_000

/** What a sheet says when the limit passed. */
export const DRAW_TIMEOUT_TEXT = 'Could not draw the card — try again.'

/** The limit passed before the drawing settled. */
export class DrawTimeout extends Error {
  constructor() {
    super('drawing took too long')
    this.name = 'DrawTimeout'
  }
}

/** `p`, or a DrawTimeout once `ms` have passed without it settling. */
export function withDrawLimit<T>(p: Promise<T>, ms = DRAW_LIMIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DrawTimeout()), ms) })
  return Promise.race([p, limit]).finally(() => clearTimeout(timer))
}

/** A promise that resolves after `ms`. */
export const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
