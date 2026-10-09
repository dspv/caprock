import { describe, expect, it } from 'vitest'
import { matchAppShortcut, type KeyLike } from './appkeys'

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('the app keyboard map', () => {
  it('binds Cmd on macOS', () => {
    expect(matchAppShortcut(k('t', { metaKey: true }), true)).toEqual({ kind: 'new-shell' })
    expect(matchAppShortcut(k('N', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'new-agent' })
    expect(matchAppShortcut(k('o', { metaKey: true }), true)).toEqual({ kind: 'add-project' })
    expect(matchAppShortcut(k('w', { metaKey: true }), true)).toEqual({ kind: 'detach-tab' })
    expect(matchAppShortcut(k('k', { metaKey: true }), true)).toEqual({ kind: 'palette' })
    expect(matchAppShortcut(k('3', { metaKey: true }), true)).toEqual({ kind: 'tab', index: 2 })
    expect(matchAppShortcut(k(',', { metaKey: true }), true)).toEqual({ kind: 'settings' })
  })

  it('starts a quick chat on ⌥⌘N, Ctrl+Alt+Shift+N elsewhere, and on no other Option chord', () => {
    expect(matchAppShortcut(k('ñ', { code: 'KeyN', metaKey: true, altKey: true }), true)).toEqual({ kind: 'quick-chat' })
    expect(matchAppShortcut(k('N', { ctrlKey: true, shiftKey: true, altKey: true }), false)).toEqual({ kind: 'quick-chat' })
    expect(matchAppShortcut(k('n', { altKey: true }), true)).toBeNull()
    expect(matchAppShortcut(k('n', { metaKey: true, shiftKey: true, altKey: true }), true)).toBeNull()
    expect(matchAppShortcut(k('m', { metaKey: true, altKey: true }), true)).toBeNull()
  })

  it('never takes a key the terminal needs on macOS', () => {
    for (const key of ['c', 'w', 't', 'd', 'z', 'r', 'a', 'e', 'k', 'l', 'j']) {
      expect(matchAppShortcut(k(key, { ctrlKey: true }), true)).toBeNull()
    }
    // Option is Meta in the terminal.
    expect(matchAppShortcut(k('t', { metaKey: true, altKey: true }), true)).toBeNull()
    expect(matchAppShortcut(k('b', { altKey: true }), true)).toBeNull()
    // Cmd+C and Cmd+V are copy and paste.
    expect(matchAppShortcut(k('c', { metaKey: true }), true)).toBeNull()
    expect(matchAppShortcut(k('v', { metaKey: true }), true)).toBeNull()
    expect(matchAppShortcut(k('Enter', { shiftKey: true }), true)).toBeNull()
  })

  it('binds Ctrl+Shift elsewhere and leaves Ctrl alone, and Ctrl+Shift+C/V to the terminal', () => {
    expect(matchAppShortcut(k('T', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'new-shell' })
    expect(matchAppShortcut(k('t', { ctrlKey: true }), false)).toBeNull()
    expect(matchAppShortcut(k('w', { ctrlKey: true }), false)).toBeNull()
    expect(matchAppShortcut(k('C', { ctrlKey: true, shiftKey: true }), false)).toBeNull()
    expect(matchAppShortcut(k('V', { ctrlKey: true, shiftKey: true }), false)).toBeNull()
    expect(matchAppShortcut(k('t', { metaKey: true }), false)).toBeNull()
  })

  it('cycles with Ctrl+Tab everywhere', () => {
    expect(matchAppShortcut(k('Tab', { ctrlKey: true }), true)).toEqual({ kind: 'next-tab' })
    expect(matchAppShortcut(k('Tab', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'prev-tab' })
    expect(matchAppShortcut(k('Tab'), true)).toBeNull()
  })

  it('splits, moves between panes and jumps to the next session waiting on you', () => {
    const br = (code: string, key: string, mods: Partial<KeyLike>) => ({ ...k(key, mods), code })
    expect(matchAppShortcut(k('e', { metaKey: true }), true)).toEqual({ kind: 'split', direction: 'row' })
    expect(matchAppShortcut(k('E', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'split', direction: 'column' })
    expect(matchAppShortcut(k('j', { metaKey: true }), true)).toEqual({ kind: 'next-waiting' })
    expect(matchAppShortcut(br('BracketRight', ']', { metaKey: true }), true)).toEqual({ kind: 'next-pane' })
    expect(matchAppShortcut(br('BracketLeft', '[', { metaKey: true }), true)).toEqual({ kind: 'prev-pane' })
    // ⇧⌘[ ] stay the tabs'.
    expect(matchAppShortcut(br('BracketRight', '}', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'next-tab' })
    expect(matchAppShortcut(k('E', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'split', direction: 'row' })
    expect(matchAppShortcut(k('J', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'next-waiting' })
    expect(matchAppShortcut(k('e', { ctrlKey: true }), false)).toBeNull()
    expect(matchAppShortcut(k('j', { ctrlKey: true }), false)).toBeNull()
  })

  it('finds in the terminal with Cmd+F, Ctrl+Shift+F off macOS, and leaves Ctrl+F to the terminal', () => {
    expect(matchAppShortcut(k('f', { metaKey: true }), true)).toEqual({ kind: 'find' })
    expect(matchAppShortcut(k('F', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'find' })
    // Ctrl+F is a shell's forward-char and less's page-down.
    expect(matchAppShortcut(k('f', { ctrlKey: true }), false)).toBeNull()
    expect(matchAppShortcut(k('f', { ctrlKey: true }), true)).toBeNull()
  })
})
