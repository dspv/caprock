/**
 * Arrow keys that change a closed <select> in place.
 *
 * In WebKit — the Mac app's webview — and in Chrome on macOS, ↑ and ↓ on a
 * focused select open its popup menu instead of moving to the next option,
 * so a sheet filled from the keyboard needed Enter, arrows and Enter again for
 * every choice (owner, 2026-10-07: "starting a session must be doable entirely
 * on the keyboard"). Space still opens the menu for a long list.
 *
 * The value is set through the element's own setter and a bubbling `change`
 * is dispatched, which is what React's onChange listens to.
 */
export function stepSelect(e: { key: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; target: EventTarget | null; preventDefault: () => void }): boolean {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false
  if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return false
  const el = e.target
  if (!(el instanceof HTMLSelectElement) || el.disabled) return false
  e.preventDefault()
  const step = e.key === 'ArrowDown' ? 1 : -1
  let i = el.selectedIndex
  do { i += step } while (i >= 0 && i < el.options.length && el.options[i]!.disabled)
  if (i < 0 || i >= el.options.length) return true
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  set?.call(el, el.options[i]!.value)
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}
