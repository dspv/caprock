import { afterEach, describe, expect, it } from 'vitest'
import type { Terminal as Xterm } from '@xterm/xterm'
import { registerBenchTerminal } from './benchhook'

type W = { __caprockBench?: { terms: Map<string, Xterm> } }
const fake = (): Xterm => ({}) as Xterm

describe('registerBenchTerminal', () => {
  afterEach(() => { delete (window as W).__caprockBench })

  it('does nothing without the bench hook', () => {
    const off = registerBenchTerminal('s1', fake())
    expect((window as W).__caprockBench).toBeUndefined()
    off()
  })

  it('keeps the newest live terminal of a session', () => {
    const terms = new Map<string, Xterm>()
    ;(window as W).__caprockBench = { terms }
    const tab = fake()
    const screen = fake()
    const offTab = registerBenchTerminal('s1', tab)
    expect(terms.get('s1')).toBe(tab)
    // The session screen mounts over the tab for a moment, then goes away.
    const offScreen = registerBenchTerminal('s1', screen)
    expect(terms.get('s1')).toBe(screen)
    offScreen()
    expect(terms.get('s1')).toBe(tab)
    offTab()
    expect(terms.has('s1')).toBe(false)
  })

  it('keeps the later terminal when the earlier one goes first', () => {
    const terms = new Map<string, Xterm>()
    ;(window as W).__caprockBench = { terms }
    const a = fake()
    const b = fake()
    const offA = registerBenchTerminal('s1', a)
    const offB = registerBenchTerminal('s1', b)
    offA()
    expect(terms.get('s1')).toBe(b)
    offB()
    expect(terms.has('s1')).toBe(false)
  })
})
