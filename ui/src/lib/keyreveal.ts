/**
 * Every key chip at once while Ctrl is held alone, off macOS (lib/appkeys
 * keyChipMode). There the chips are drawn on demand so they never cut a
 * label; holding Ctrl (with Shift or Alt, or not) for a moment with no other
 * key sets `data-show-keys` on the root, and `.app-kbd-reveal` and
 * `.app-kbd-held` show (design/tokens.css) — the way Windows apps show their
 * access keys while Alt is held.
 *
 * Only after a pause, and gone at the first other key: Ctrl+C in a terminal,
 * or any chord typed at speed, never flashes the chips. Gone again when Ctrl
 * is let go or the window loses focus.
 */

/** How long Ctrl is held alone before the chips show, in ms. */
export const REVEAL_DELAY_MS = 450

const ATTR = 'data-show-keys'
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'])

/** Starts listening; returns the way to stop. Safe to call more than once. */
export function installKeyReveal(root: HTMLElement = document.documentElement, delay = REVEAL_DELAY_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const hide = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    root.removeAttribute(ATTR)
  }
  const down = (e: KeyboardEvent) => {
    if (!MODIFIERS.has(e.key)) { hide(); return }
    // AltGr arrives as Ctrl+Alt on Windows layouts: a character, not a reveal.
    if (e.key === 'AltGraph' || e.metaKey) { hide(); return }
    if (!e.ctrlKey || timer !== undefined || root.hasAttribute(ATTR)) return
    timer = setTimeout(() => { timer = undefined; root.setAttribute(ATTR, '') }, delay)
  }
  const up = (e: KeyboardEvent) => {
    if (e.key === 'Control' || !e.ctrlKey) hide()
  }
  window.addEventListener('keydown', down, true)
  window.addEventListener('keyup', up, true)
  window.addEventListener('blur', hide)
  window.addEventListener('pointerdown', hide, true)
  return () => {
    hide()
    window.removeEventListener('keydown', down, true)
    window.removeEventListener('keyup', up, true)
    window.removeEventListener('blur', hide)
    window.removeEventListener('pointerdown', hide, true)
  }
}
