import { describe, expect, it } from 'vitest'
import { newShellCloseKey, newShellHintText, onlyPrompt, PROMPT_ROWS } from './newshellhint'

describe('the new shell hint', () => {
  it('spells the close key for each OS', () => {
    expect(newShellCloseKey(true)).toBe('⌘W')
    expect(newShellCloseKey(false)).toBe('Ctrl+Shift+W')
    expect(newShellHintText(true)).toBe('Run claude, codex or any command · ⌘W closes this tab')
    expect(newShellHintText(false)).toBe('Run claude, codex or any command · Ctrl+Shift+W closes this tab')
  })

  it('reads a shell as empty while its cursor is on the prompt rows', () => {
    expect(onlyPrompt({ baseY: 0, cursorY: 0 })).toBe(true)
    expect(onlyPrompt({ baseY: 0, cursorY: PROMPT_ROWS })).toBe(true)
    expect(onlyPrompt({ baseY: 0, cursorY: PROMPT_ROWS + 1 })).toBe(false)
    // Scrollback counts: a shell with history that scrolled is not empty.
    expect(onlyPrompt({ baseY: 40, cursorY: 0 })).toBe(false)
  })
})
