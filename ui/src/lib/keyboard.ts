/**
 * Putting a phone's on-screen keyboard away (.ai/04-ui.md § From a phone,
 * *The keyboard goes away*): the field loses the focus, which is what lowers
 * the keyboard on a web page; in the iOS app the plugin is asked as well
 * (native/keyboard.ts), as WKWebView can keep it up after a blur.
 */
import { isNativeApp } from '@/native/platform'

export function hideKeyboard(field?: HTMLElement | null): void {
  const el = field ?? (typeof document === 'undefined' ? null : document.activeElement)
  if (el instanceof HTMLElement) el.blur()
  if (isNativeApp()) {
    void import('@/native/keyboard').then((k) => k.hideNativeKeyboard()).catch(() => { /* no plugin: the blur did it */ })
  }
}

/** Whether `el` is a place the keyboard types into (a field, not a button). */
export function isTypingField(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false
  if (el instanceof HTMLTextAreaElement) return !el.readOnly
  if (el instanceof HTMLInputElement) return !el.readOnly && !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'].includes(el.type)
  return el.isContentEditable === true
}
