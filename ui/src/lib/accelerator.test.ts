import { describe, expect, it } from 'vitest'
import { formatAccelerator, recordAccelerator } from './accelerator'

const key = (code: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}, k = 'x') => ({
  key: k, code, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta,
})

describe('recordAccelerator', () => {
  it('reads modifiers and the physical key, in the shell’s order', () => {
    expect(recordAccelerator(key('KeyC', { ctrl: true, alt: true, meta: true }))).toEqual({ kind: 'accelerator', accelerator: 'Control+Alt+Super+KeyC' })
    expect(recordAccelerator(key('Space', { alt: true, shift: true }))).toEqual({ kind: 'accelerator', accelerator: 'Alt+Shift+Space' })
  })
  it('waits while only a modifier is down', () => {
    expect(recordAccelerator(key('MetaLeft', { meta: true }, 'Meta'))).toEqual({ kind: 'modifier-only' })
  })
  it('refuses a key that would be taken from typing', () => {
    expect(recordAccelerator(key('KeyC'))).toEqual({ kind: 'needs-modifier' })
    expect(recordAccelerator(key('KeyC', { shift: true }))).toEqual({ kind: 'needs-modifier' })
  })
  it('refuses keys the shell cannot register', () => {
    expect(recordAccelerator(key('Enter', { ctrl: true }, 'Enter')).kind).toBe('unsupported')
  })
})

describe('formatAccelerator', () => {
  it('shows each platform’s own names', () => {
    expect(formatAccelerator('control+alt+super+KeyC', 'macos')).toBe('⌃⌥⌘C')
    expect(formatAccelerator('alt+super+KeyC', 'windows')).toBe('Alt+Win+C')
    expect(formatAccelerator('alt+super+KeyC', 'linux')).toBe('Alt+Super+C')
    expect(formatAccelerator('shift+control+Digit1', 'macos')).toBe('⌃⇧1')
  })
})
