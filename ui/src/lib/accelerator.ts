/**
 * The global hotkey's accelerator strings (WP-10, F09), as the shell parses
 * them: `control+alt+super+KeyC`, modifiers then one key by its physical
 * code, so a layout never changes which key it is.
 */
import type { KeyLike } from './appkeys'

const NAMED = new Set([
  'Space', 'Backquote', 'Backslash', 'BracketLeft', 'BracketRight', 'Comma', 'Equal', 'Minus',
  'Period', 'Quote', 'Semicolon', 'Slash', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
])

function isUsableCode(code: string): boolean {
  return /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || /^F([1-9]|1[0-2])$/.test(code) || NAMED.has(code)
}

export type Recorded =
  | { kind: 'accelerator'; accelerator: string }
  | { kind: 'modifier-only' }
  | { kind: 'needs-modifier' }
  | { kind: 'unsupported'; code: string }

/** Reads a key press in the Settings field as an accelerator, or says why it is not one. */
export function recordAccelerator(e: KeyLike): Recorded {
  const code = e.code ?? ''
  if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code) || ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
    return { kind: 'modifier-only' }
  }
  if (!isUsableCode(code)) return { kind: 'unsupported', code: code || e.key }
  // Shift alone would take a capital letter from every app.
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return { kind: 'needs-modifier' }
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean)
  return { kind: 'accelerator', accelerator: [...mods, code].join('+') }
}

function keyLabel(code: string): string {
  if (/^Key[A-Z]$/i.test(code)) return code.slice(3).toUpperCase()
  if (/^Digit[0-9]$/i.test(code)) return code.slice(5)
  const arrows: Record<string, string> = { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' }
  return arrows[code.toLowerCase()] ?? code
}

/** "⌃⌥⌘C" on macOS, "Ctrl+Alt+Win+C" on Windows, "Ctrl+Alt+Super+C" on Linux. */
export function formatAccelerator(accelerator: string, platform: 'macos' | 'windows' | 'linux'): string {
  const parts = accelerator.split('+')
  const key = keyLabel(parts.pop() ?? '')
  const has = (...names: string[]) => parts.some((p) => names.includes(p.toLowerCase()))
  const ctrl = has('control', 'ctrl')
  const alt = has('alt', 'option')
  const shift = has('shift')
  const sup = has('super', 'cmd', 'command')
  if (platform === 'macos') {
    return `${ctrl ? '⌃' : ''}${alt ? '⌥' : ''}${shift ? '⇧' : ''}${sup ? '⌘' : ''}${key}`
  }
  const win = platform === 'windows' ? 'Win' : 'Super'
  return [ctrl && 'Ctrl', alt && 'Alt', shift && 'Shift', sup && win, key].filter(Boolean).join('+')
}
