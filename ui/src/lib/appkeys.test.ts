import { describe, expect, it } from 'vitest'
import { matchAppShortcut, moveKeysLine, ownsTerminalKey, stripKey, type KeyLike, keys, tabDigit, tabKey } from './appkeys'

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
  // Owner, 2026-10-13 (translated): "Command+digit focuses that project …
  // Command+Up/Down to move, or Option+Left/Right". ⌥← ⌥→ and ⌘↑ ⌘↓ are the
  // terminal's, so the moves are ⌥⌘ arrows, Alt+Shift arrows elsewhere.
  // Owner, 2026-10-14 (translated): "I just want to switch between them
  // with key combos". ⌘N is the Nth tab, always; projects have no digit.
  it('maps ⌘1–⌘9 to tabs, no digit chord to projects, and ⌥⌘ arrows to sessions and projects', () => {
    for (let d = 1; d <= 9; d++) {
      expect(matchAppShortcut(k(String(d), { metaKey: true }), true)).toEqual({ kind: 'tab', index: d - 1 })
      expect(matchAppShortcut(k(String(d), { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'tab', index: d - 1 })
      // The project chords of 2026-10-14's first try are gone (owner: no digits for projects).
      expect(matchAppShortcut(k(String(d), { metaKey: true, ctrlKey: true }), true)).toBeNull()
      expect(matchAppShortcut(k('!@#$%^&*('[d - 1]!, { code: `Digit${d}`, altKey: true, shiftKey: true }), false)).toBeNull()
    }
    expect(matchAppShortcut(k('ArrowDown', { metaKey: true, altKey: true }), true)).toEqual({ kind: 'session', delta: 1 })
    expect(matchAppShortcut(k('ArrowUp', { metaKey: true, altKey: true }), true)).toEqual({ kind: 'session', delta: -1 })
    expect(matchAppShortcut(k('ArrowRight', { metaKey: true, altKey: true }), true)).toEqual({ kind: 'step-project', delta: 1 })
    expect(matchAppShortcut(k('ArrowLeft', { metaKey: true, altKey: true }), true)).toEqual({ kind: 'step-project', delta: -1 })
    expect(matchAppShortcut(k('ArrowDown', { altKey: true, shiftKey: true }), false)).toEqual({ kind: 'session', delta: 1 })
    expect(matchAppShortcut(k('ArrowLeft', { altKey: true, shiftKey: true }), false)).toEqual({ kind: 'step-project', delta: -1 })
    // Alt+Shift+N is no app chord; only the arrows are.
    expect(matchAppShortcut(k('n', { altKey: true, shiftKey: true }), false)).toBeNull()
    expect(matchAppShortcut(k('0', { altKey: true, shiftKey: true }), false)).toBeNull()
  })

  // Alt+digit is readline's and PSReadLine's digit-argument and a GNOME
  // Terminal tab; Ctrl+Alt+digit is AltGr+digit ({ [ @ on European
  // layouts) and a Windows Terminal tab; Ctrl+digit and ⌃digit the terminal's.
  it('leaves the terminal its digits: Alt, Ctrl+Alt, Ctrl, ⌃ and ⌥', () => {
    for (let d = 1; d <= 9; d++) {
      const key = String(d)
      expect(matchAppShortcut(k(key, { altKey: true }), false), `Alt+${d}`).toBeNull()
      expect(matchAppShortcut(k(key, { ctrlKey: true, altKey: true }), false), `Ctrl+Alt+${d}`).toBeNull()
      expect(matchAppShortcut(k(key, { ctrlKey: true }), false), `Ctrl+${d}`).toBeNull()
      expect(matchAppShortcut(k(key, { ctrlKey: true }), true), `⌃${d}`).toBeNull()
      expect(matchAppShortcut(k(key, { altKey: true }), true), `⌥${d}`).toBeNull()
      expect(matchAppShortcut(k(key, { metaKey: true, ctrlKey: true, shiftKey: true }), true), `⌃⇧⌘${d}`).toBeNull()
    }
  })

  it('says how to move in one line, in this platform\'s words', () => {
    expect(moveKeysLine(true)).toBe('⌘1–9 switch tabs in the order you opened them · double-click a tab to rename')
    expect(moveKeysLine(false)).toBe('Ctrl+Shift+1–9 switch tabs in the order you opened them · double-click a tab to rename')
    expect(keys('⌃Tab', false)).toBe('Ctrl+Tab')
  })

  // PowerShell's PSReadLine (Windows mode) binds Ctrl+Shift+← → to
  // SelectBackwardWord / SelectNextWord and Ctrl+← → to word moves; bash and
  // zsh bind Ctrl+← → and Alt+← → (Meta) to word moves.
  it('leaves the terminal its arrows: ⌥← ⌥→ word-jump, ⌘↑ ⌘↓ ⌘← ⌘→, Ctrl, Alt and Ctrl+Shift arrows', () => {
    for (const a of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      expect(matchAppShortcut(k(a, { altKey: true }), true), `⌥${a}`).toBeNull()
      expect(matchAppShortcut(k(a, { metaKey: true }), true), `⌘${a}`).toBeNull()
      expect(matchAppShortcut(k(a, { metaKey: true, shiftKey: true }), true), `⇧⌘${a}`).toBeNull()
      expect(matchAppShortcut(k(a, { ctrlKey: true }), true), `⌃${a}`).toBeNull()
      expect(matchAppShortcut(k(a, { ctrlKey: true }), false), `Ctrl+${a}`).toBeNull()
      expect(matchAppShortcut(k(a, { altKey: true }), false), `Alt+${a}`).toBeNull()
      expect(matchAppShortcut(k(a, { ctrlKey: true, shiftKey: true }), false), `Ctrl+Shift+${a}`).toBeNull()
      expect(matchAppShortcut(k(a, { altKey: true, shiftKey: true }), true), `⌥⇧${a}`).toBeNull()
      // Ctrl+Alt arrows switch workspaces in GNOME, Ctrl+Alt+Shift move the window there.
      expect(matchAppShortcut(k(a, { ctrlKey: true, altKey: true }), false), `Ctrl+Alt+${a}`).toBeNull()
      expect(matchAppShortcut(k(a, { ctrlKey: true, altKey: true, shiftKey: true }), false), `Ctrl+Alt+Shift+${a}`).toBeNull()
    }
  })

  it('spells the arrow chords Alt+Shift for Windows and Linux, and moving a row Ctrl+Shift', () => {
    expect(keys('⌥⌘↓, ⌥⌘↑', false)).toBe('Alt+Shift+↓, Alt+Shift+↑')
    expect(keys('⌥⌘→, ⌥⌘←', false)).toBe('Alt+Shift+→, Alt+Shift+←')
    expect(keys('⌥⇧↑, ⌥⇧↓', false)).toBe('Ctrl+Shift+↑, Ctrl+Shift+↓')
    expect(keys('⌥⌘↓', true)).toBe('⌥⌘↓')
  })

  it('binds Cmd on macOS', () => {
    expect(matchAppShortcut(k('t', { metaKey: true }), true)).toEqual({ kind: 'new-shell' })
    expect(matchAppShortcut(k('N', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'new-agent' })
    expect(matchAppShortcut(k('o', { metaKey: true }), true)).toEqual({ kind: 'add-project' })
    expect(matchAppShortcut(k('w', { metaKey: true }), true)).toEqual({ kind: 'detach-tab' })
    expect(matchAppShortcut(k('k', { metaKey: true }), true)).toEqual({ kind: 'palette' })
    expect(matchAppShortcut(k('3', { metaKey: true }), true)).toEqual({ kind: 'tab', index: 2 })
    expect(matchAppShortcut(k(',', { metaKey: true }), true)).toEqual({ kind: 'settings' })
  })

  it('opens and closes the session deck on ⌘B, Ctrl+Shift+B elsewhere, and on no Ctrl or Option B', () => {
    expect(matchAppShortcut(k('b', { metaKey: true }), true)).toEqual({ kind: 'deck' })
    expect(matchAppShortcut(k('B', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'deck' })
    // Ctrl+B and Option+B are the terminal's (tmux prefix, Meta-b word back).
    expect(matchAppShortcut(k('b', { ctrlKey: true }), true)).toBeNull()
    expect(matchAppShortcut(k('b', { ctrlKey: true }), false)).toBeNull()
    expect(matchAppShortcut(k('b', { altKey: true }), true)).toBeNull()
    expect(keys('⌘B', false)).toBe('Ctrl+Shift+B')
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

describe('a key label off macOS', () => {
  it('writes the app chords as Ctrl+Shift, Quick chat with Alt, Enter with Ctrl alone', () => {
    expect(keys('⇧⌘N', false)).toBe('Ctrl+Shift+N')
    expect(keys('⌘W', false)).toBe('Ctrl+Shift+W')
    expect(keys('⌥⌘N', false)).toBe('Ctrl+Alt+Shift+N')
    expect(keys('⌘↵', false)).toBe('Ctrl+Enter')
    expect(keys('⇧⌘↵', false)).toBe('Ctrl+Shift+Enter')
    expect(keys('⌃Tab, ⇧⌘[ ]', false)).toBe('Ctrl+Tab, Ctrl+Shift+[ ]')
    expect(keys('⌘1–8, ⌘9', false)).toBe('Ctrl+Shift+1–8, Ctrl+Shift+9')
  })
  it('says F5 for reload and nothing for the pane keys, which have none there', () => {
    expect(keys('⌘R', false)).toBe('F5')
    expect(keys('⌘[ ]', false)).toBe('')
    expect(keys('⌘]', false)).toBe('')
  })
  it('leaves macOS as written', () => {
    expect(keys('⇧⌘N', true)).toBe('⇧⌘N')
  })
})

describe('the jump key on a tab', () => {
  it('numbers the first eight and gives ⌘9 to the last, as the keys do', () => {
    expect([0, 1, 2].map((i) => tabDigit(i, 3))).toEqual([1, 2, 3])
    expect(tabDigit(8, 12)).toBeNull()
    expect(tabDigit(11, 12)).toBe(9)
    expect(tabDigit(8, 9)).toBe(9)
  })
  // The pinned tab's ⌘0 and ⌘, are drawn short as a tab's ⌘N is, and the
  // short form off macOS is the chord that works there.
  it('draws the pinned tab\'s keys short, and the short form is the chord off macOS', () => {
    expect(stripKey('0', true)).toBe('⌘0')
    expect(stripKey(',', false)).toBe('Ctrl⇧,')
    for (const [ch, code, kind] of [['0', 'Digit0', 'dashboard'], [',', 'Comma', 'settings']] as const) {
      expect(stripKey(ch, false).replace('⇧', '+Shift+')).toBe(keys(`⌘${ch}`, false))
      expect(matchAppShortcut({ key: ch, code, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, false)).toEqual({ kind })
    }
  })
  it('is short on every platform', () => {
    expect(tabKey(3, true)).toBe('⌘3')
    expect(tabKey(3, false)).toBe('Ctrl⇧3')
  })
})

describe('zoom keys', () => {
  const k = (key: string, code: string, mods: Partial<KeyLike>) => ({ key, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods })
  it('maps ⌘= ⌘+ ⌘- ⇧⌘0 on macOS, and ⌘0 to the Dashboard', () => {
    expect(matchAppShortcut(k('=', 'Equal', { metaKey: true }), true)).toEqual({ kind: 'zoom', step: 1 })
    expect(matchAppShortcut(k('+', 'Equal', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'zoom', step: 1 })
    expect(matchAppShortcut(k('-', 'Minus', { metaKey: true }), true)).toEqual({ kind: 'zoom', step: -1 })
    expect(matchAppShortcut(k(')', 'Digit0', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'zoom', step: 0 })
    expect(matchAppShortcut(k('0', 'Digit0', { metaKey: true }), true)).toEqual({ kind: 'dashboard' })
    expect(matchAppShortcut(k('D', 'KeyD', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'dashboard' })
  })
  it('opens the diff of the session in front on ⇧⌘G, Ctrl+Shift+G elsewhere', () => {
    expect(matchAppShortcut(k('G', 'KeyG', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'changes' })
    expect(matchAppShortcut(k('G', 'KeyG', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'changes' })
    expect(matchAppShortcut(k('g', 'KeyG', { metaKey: true }), true)).toBeNull()
  })
  it('maps Ctrl+Shift elsewhere and leaves Ctrl alone to the terminal', () => {
    expect(matchAppShortcut(k('+', 'Equal', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'zoom', step: 1 })
    expect(matchAppShortcut(k('_', 'Minus', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'zoom', step: -1 })
    expect(matchAppShortcut(k('-', 'Minus', { ctrlKey: true }), false)).toBeNull()
  })
})

// Every shortcut the app lists works on Windows and Linux as it reads there
// (owner, 2026-10-11: "always check Linux and Windows when a shortcut
// changes, or it is an epic fail"). For each single-key chord in SHORTCUTS,
// the macOS chord and the text `keys()` shows off macOS must reach the same
// command.
import { SHORTCUTS } from './appkeys'

describe('every listed shortcut, on every OS', () => {
  const chords = SHORTCUTS.flatMap(([k]) => k.split(', ')).filter((c) => /^[⇧⌘⌥⌃]+[A-Z0-9,\\.\-=+[\]↑↓←→]$/.test(c) && c.includes('⌘'))
  const event = (code: string, key: string, mods: Partial<KeyLike>): KeyLike => ({ key, code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods } as KeyLike)
  const codeOf = (ch: string) => (/[A-Z]/.test(ch) ? `Key${ch}` : /[0-9]/.test(ch) ? `Digit${ch}` : ({ ',': 'Comma', '\\': 'Backslash', '.': 'Period', '-': 'Minus', '=': 'Equal', '+': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight' } as Record<string, string>)[ch] ?? ch)
  // An arrow's key is its name, as a browser reports it.
  const keyOf = (ch: string) => ({ '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight' } as Record<string, string>)[ch] ?? ch.toLowerCase()

  it('has chords to check, the arrow chords among them', () => {
    expect(chords.length).toBeGreaterThan(10)
    expect(chords).toEqual(expect.arrayContaining(['⌘9', '⌥⌘↓', '⌥⌘↑', '⌥⌘→', '⌥⌘←']))
    expect(chords.some((c) => c.startsWith('⌃⌘'))).toBe(false)
  })

  for (const c of chords) {
    it(`${c} reaches the same command as ${keys(c, false)}`, () => {
      if (c === '⌘R') return // the webview's own reload, not an app command
      const ch = c.slice(-1)
      const mac = matchAppShortcut(event(codeOf(ch), keyOf(ch), { metaKey: true, shiftKey: c.includes('⇧'), altKey: c.includes('⌥'), ctrlKey: c.includes('⌃') }), true)
      expect(mac, `${c} on macOS`).not.toBeNull()
      const off = keys(c, false)
      if (off === '' || off === 'F5') return // macOS-only, or the browser's own reload
      const parts = off.split('+')
      const last = parts[parts.length - 1]!
      const k1 = last === 'F5' ? 'F5' : last
      const ev = event(last === 'F5' ? 'F5' : codeOf(k1.toUpperCase().length === 1 ? k1.toUpperCase() : k1), keyOf(k1), { ctrlKey: parts.includes('Ctrl'), shiftKey: parts.includes('Shift'), altKey: parts.includes('Alt') })
      expect(matchAppShortcut(ev, false), `${off} off macOS`).toEqual(mac)
    })
  }

  // The ranges list one chord each (⌘1–8); every digit in them is pressed.
  it('⌘1–⌘9 reach the same tab as Ctrl+Shift+1–9', () => {
    for (let d = 1; d <= 9; d++) {
      const mac = matchAppShortcut(event(`Digit${d}`, String(d), { metaKey: true }), true)
      expect(mac).toEqual({ kind: 'tab', index: d - 1 })
      expect(keys(`⌘${d}`, false)).toBe(`Ctrl+Shift+${d}`)
      // With Shift held a digit's key is its symbol; the code is what counts.
      expect(matchAppShortcut(event(`Digit${d}`, '!@#$%^&*('[d - 1]!, { ctrlKey: true, shiftKey: true }), false)).toEqual(mac)
    }
  })

  // Owner, 2026-10-12: ⌥⌘N started a chat "without asking with whom"
  // (translated). The chord is unchanged on every OS; what the list says it
  // does changed with it.
  // Owner, 2026-10-14: Expand needs a key. ⌘B is the deck, so off macOS
  // Ctrl+Shift+B is taken by it and Expand takes Alt as well.
  it('makes ⌘P the Pipeline tab and back, Ctrl+Shift+P off macOS, and keeps ⇧⌘B as a silent alias', () => {
    expect(SHORTCUTS.find(([k]) => k === '⌘P')?.[1]).toMatch(/^Pipeline, in a tab of its own; there, back to where you were/)
    // The pinned Pipeline tab's chip is the same chord, as the strip spells it.
    expect(stripKey('P', true)).toBe('⌘P')
    expect(stripKey('P', false).replace('⇧', '+Shift+')).toBe(keys('⌘P', false))
    expect(SHORTCUTS.some(([k]) => k.split(', ').includes('⇧⌘B'))).toBe(false)
    expect(keys('⌘P', false)).toBe('Ctrl+Shift+P')
    expect(matchAppShortcut(event('KeyP', 'p', { metaKey: true }), true)).toEqual({ kind: 'pipeline' })
    expect(matchAppShortcut(event('KeyP', 'P', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'pipeline' })
    // The older key, on both platforms.
    expect(matchAppShortcut(event('KeyB', 'B', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'pipeline' })
    expect(matchAppShortcut(event('KeyB', 'B', { ctrlKey: true, shiftKey: true, altKey: true }), false)).toEqual({ kind: 'pipeline' })
    expect(keys('⌘B', false)).toBe('Ctrl+Shift+B')
    expect(matchAppShortcut(event('KeyB', 'b', { metaKey: true }), true)).toEqual({ kind: 'deck' })
    expect(matchAppShortcut(event('KeyB', 'B', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'deck' })
    // Ctrl+P and Ctrl+B alone stay the terminal's (previous line; tmux's prefix, back-char).
    expect(matchAppShortcut(event('KeyP', 'p', { ctrlKey: true }), false)).toBeNull()
    expect(matchAppShortcut(event('KeyB', 'b', { ctrlKey: true }), false)).toBeNull()
  })

  // Owner, 2026-10-15, translated: "bind shortcuts to the names: ⌘D
  // Dashboard (keep ⌘0 too)". Off macOS it is Ctrl+Shift+D, never Ctrl+D,
  // a shell's end of input.
  it('makes ⌘D the Dashboard beside ⌘0, Ctrl+Shift+D off macOS, and leaves Ctrl+D to the shell', () => {
    expect(SHORTCUTS.find(([k]) => k === '⌘D, ⌘0')?.[1]).toMatch(/^Dashboard/)
    expect(keys('⌘D, ⌘0', false)).toBe('Ctrl+Shift+D, Ctrl+Shift+0')
    expect(matchAppShortcut(event('KeyD', 'd', { metaKey: true }), true)).toEqual({ kind: 'dashboard' })
    expect(matchAppShortcut(event('Digit0', '0', { metaKey: true }), true)).toEqual({ kind: 'dashboard' })
    expect(matchAppShortcut(event('KeyD', 'D', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'dashboard' })
    expect(matchAppShortcut(event('KeyD', 'D', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'dashboard' })
    expect(matchAppShortcut(event('KeyD', 'd', { ctrlKey: true }), false)).toBeNull()
    expect(ownsTerminalKey(event('KeyD', 'd', { ctrlKey: true }), false)).toBe(false)
  })

  // ⌘T stays New shell and ⌘W Close, as in every terminal; the theme and
  // Work take Shift, and off macOS Alt as well, since Ctrl+Shift+T and
  // Ctrl+Shift+W are ⌘T's and ⌘W's there.
  it('makes ⇧⌘T the theme picker and ⇧⌘W Work, Ctrl+Alt+Shift+T and W off macOS, beside New shell and Close', () => {
    expect(SHORTCUTS.find(([k]) => k === '⇧⌘T')?.[1]).toMatch(/^Theme/)
    expect(SHORTCUTS.find(([k]) => k === '⇧⌘W')?.[1]).toMatch(/^Work on the dashboard/)
    expect(keys('⇧⌘T', false)).toBe('Ctrl+Alt+Shift+T')
    expect(keys('⇧⌘W', false)).toBe('Ctrl+Alt+Shift+W')
    expect(matchAppShortcut(event('KeyT', 'T', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'theme' })
    expect(matchAppShortcut(event('KeyW', 'W', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'work' })
    expect(matchAppShortcut(event('KeyT', 't', { metaKey: true }), true)).toEqual({ kind: 'new-shell' })
    expect(matchAppShortcut(event('KeyW', 'w', { metaKey: true }), true)).toEqual({ kind: 'detach-tab' })
    expect(matchAppShortcut(event('KeyT', 'T', { ctrlKey: true, shiftKey: true, altKey: true }), false)).toEqual({ kind: 'theme' })
    expect(matchAppShortcut(event('KeyW', 'W', { ctrlKey: true, shiftKey: true, altKey: true }), false)).toEqual({ kind: 'work' })
    expect(matchAppShortcut(event('KeyT', 'T', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'new-shell' })
    expect(matchAppShortcut(event('KeyW', 'W', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'detach-tab' })
    // Ctrl+Alt+T without Shift (GNOME's terminal) is never ours.
    expect(matchAppShortcut(event('KeyT', 't', { ctrlKey: true, altKey: true }), false)).toBeNull()
  })

  // Rule 12: no two rows of the list may read the same off macOS.
  it('spells every listed chord differently off macOS', () => {
    const seen = new Map<string, string>()
    for (const [k, does] of SHORTCUTS) {
      for (const c of k.split(', ')) {
        const off = keys(c, false)
        if (!off) continue
        const prev = seen.get(off)
        expect(prev === undefined || prev === does, `${off}: ${prev} and ${does}`).toBe(true)
        seen.set(off, does)
      }
    }
  })

  // Owner, 2026-10-14: Send feedback opens from the keyboard. ⌘F is Find,
  // so off macOS Ctrl+Shift+F stays Find and feedback takes Alt as well.
  it('makes ⇧⌘F Send feedback, Ctrl+Alt+Shift+F off macOS, beside Find', () => {
    expect(SHORTCUTS.find(([k]) => k === '⇧⌘F')?.[1]).toMatch(/^Send feedback/)
    expect(keys('⇧⌘F', false)).toBe('Ctrl+Alt+Shift+F')
    expect(matchAppShortcut(event('KeyF', 'F', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'feedback' })
    expect(matchAppShortcut(event('KeyF', 'f', { metaKey: true }), true)).toEqual({ kind: 'find' })
    expect(matchAppShortcut(event('KeyF', 'F', { ctrlKey: true, shiftKey: true, altKey: true }), false)).toEqual({ kind: 'feedback' })
    expect(matchAppShortcut(event('KeyF', 'F', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'find' })
    // Ctrl+F alone stays the terminal's (readline's forward-char).
    expect(matchAppShortcut(event('KeyF', 'f', { ctrlKey: true }), false)).toBeNull()
  })

  // Owner, 2026-10-14: Mail on a button with its own key. Plain ⌘M stays
  // the window's Minimize; Ctrl+M alone stays the terminal's Enter.
  it('makes ⇧⌘M Mail, Ctrl+Shift+M off macOS, and leaves ⌘M and Ctrl+M alone', () => {
    expect(SHORTCUTS.find(([k]) => k === '⇧⌘M')?.[1]).toMatch(/^Mail/)
    expect(keys('⇧⌘M', false)).toBe('Ctrl+Shift+M')
    expect(matchAppShortcut(event('KeyM', 'M', { metaKey: true, shiftKey: true }), true)).toEqual({ kind: 'mail' })
    expect(matchAppShortcut(event('KeyM', 'm', { metaKey: true }), true)).toBeNull()
    expect(matchAppShortcut(event('KeyM', 'M', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'mail' })
    expect(matchAppShortcut(event('KeyM', 'm', { ctrlKey: true }), false)).toBeNull()
  })

  it('lists ⌥⌘N as starting at once, Ctrl+Alt+Shift+N off macOS', () => {
    expect(SHORTCUTS.find(([k]) => k === '⌥⌘N')?.[1]).toMatch(/starts at once on the model used last/)
    expect(keys('⌥⌘N', false)).toBe('Ctrl+Alt+Shift+N')
    expect(matchAppShortcut(event('KeyN', 'n', { ctrlKey: true, shiftKey: true, altKey: true }), false)).toEqual({ kind: 'quick-chat' })
    expect(matchAppShortcut(event('KeyN', 'n', { ctrlKey: true, shiftKey: true, altKey: true }), true)).toBeNull()
  })
})
