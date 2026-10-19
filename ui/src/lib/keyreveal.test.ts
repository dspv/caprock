import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installKeyReveal } from './keyreveal'

describe('installKeyReveal', () => {
  let stop: () => void
  const root = () => document.documentElement
  const press = (key: string, mods: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key, ...mods }))
  const release = (key: string, mods: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keyup', { key, ...mods }))

  beforeEach(() => {
    vi.useFakeTimers()
    stop = installKeyReveal(root(), 400)
  })
  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  it('shows the chips after Ctrl is held alone, and hides them when it is let go', () => {
    press('Control', { ctrlKey: true })
    vi.advanceTimersByTime(399)
    expect(root().hasAttribute('data-show-keys')).toBe(false)
    vi.advanceTimersByTime(1)
    expect(root().hasAttribute('data-show-keys')).toBe(true)
    // Shift added to the chord prefix keeps them.
    press('Shift', { ctrlKey: true, shiftKey: true })
    expect(root().hasAttribute('data-show-keys')).toBe(true)
    release('Control', { shiftKey: true })
    expect(root().hasAttribute('data-show-keys')).toBe(false)
  })

  it('never flashes them for a chord typed at speed, Ctrl+C in a terminal', () => {
    press('Control', { ctrlKey: true })
    press('c', { ctrlKey: true })
    vi.advanceTimersByTime(1000)
    expect(root().hasAttribute('data-show-keys')).toBe(false)
  })

  it('ignores AltGr, which types a character', () => {
    press('AltGraph', { ctrlKey: true, altKey: true })
    vi.advanceTimersByTime(1000)
    expect(root().hasAttribute('data-show-keys')).toBe(false)
  })

  it('hides them when the window loses focus', () => {
    press('Control', { ctrlKey: true })
    vi.advanceTimersByTime(500)
    window.dispatchEvent(new Event('blur'))
    expect(root().hasAttribute('data-show-keys')).toBe(false)
  })
})
