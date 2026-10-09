/**
 * Where each terminal was scrolled when the app restarted into an update
 * (F20): saved the moment the update starts installing, given back once to
 * the same session's terminal after the relaunch, when its scrollback has
 * been replayed. A terminal at the bottom saves nothing and lands at the
 * bottom, as every terminal does on a launch.
 *
 * Tabs, splits, the front tab and the sidebar are already kept
 * (`caprock.app.workspace.v1`, `caprock.app.hidden-projects`); this is the one thing
 * a fresh page could not know.
 */

export const RESUME_KEY = 'caprock.app.resume.v1'
/** An entry older than this is from some other launch and is ignored. */
export const RESUME_TTL_MS = 10 * 60_000

export interface ScrollMark {
  /** The first line in view (xterm's viewportY). */
  top: number
  /** Lines in the buffer then (baseY + rows): equal after the replay means `top` is the same line. */
  total: number
  /** Lines between the view and the bottom, for a replay of a different length. */
  fromBottom: number
}

type Saved = { at: number; panes: Record<string, ScrollMark> }

function read(): Saved | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(RESUME_KEY) ?? 'null') as Saved | null
    return v && typeof v.at === 'number' && v.panes && typeof v.panes === 'object' ? v : undefined
  } catch {
    return undefined
  }
}

/** Records one terminal's place; `null` (at the bottom) clears it. */
export function saveScroll(sessionId: string, mark: ScrollMark | null, now = Date.now()) {
  const cur = read()
  const panes = cur && now - cur.at < RESUME_TTL_MS ? { ...cur.panes } : {}
  if (mark) panes[sessionId] = mark
  else delete panes[sessionId]
  try { localStorage.setItem(RESUME_KEY, JSON.stringify({ at: now, panes })) } catch { /* not kept: lands at the bottom */ }
}

/** The place saved for this session, once; undefined when none or stale. */
export function takeScroll(sessionId: string, now = Date.now()): ScrollMark | undefined {
  const cur = read()
  if (!cur) return undefined
  const mark = cur.panes[sessionId]
  if (!mark) return undefined
  const panes = { ...cur.panes }
  delete panes[sessionId]
  try { localStorage.setItem(RESUME_KEY, JSON.stringify({ at: cur.at, panes })) } catch { /* taken anyway */ }
  return now - cur.at < RESUME_TTL_MS ? mark : undefined
}

/** The mark for a buffer, or null at the bottom. */
export function markOf(viewportY: number, baseY: number, rows: number): ScrollMark | null {
  if (viewportY >= baseY) return null
  return { top: viewportY, total: baseY + rows, fromBottom: baseY - viewportY }
}

/** The line to scroll to after the replay, given the buffer then. */
export function lineFor(mark: ScrollMark, baseY: number, rows: number): number {
  const line = baseY + rows === mark.total ? mark.top : baseY - mark.fromBottom
  return Math.max(0, Math.min(baseY, line))
}
