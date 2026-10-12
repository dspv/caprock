import { afterEach, describe, expect, it } from 'vitest'
import { HISTORY_MAX, composerEnabled, composerFits, historyStep, loadHistory, pushHistory, setComposerEnabled, subscribeComposer } from './composer'
import type { SessionSummary } from './api'

describe('composer', () => {
  afterEach(() => {
    setComposerEnabled(false)
    localStorage.clear()
  })

  it('is off by default and tells every listener when it is switched', () => {
    expect(composerEnabled()).toBe(false)
    const seen: boolean[] = []
    const off = subscribeComposer((on) => seen.push(on))
    setComposerEnabled(true)
    expect(localStorage.getItem('caprock.app.composer')).toBe('1')
    setComposerEnabled(false)
    off()
    expect(seen).toEqual([true, false])
    expect(localStorage.getItem('caprock.app.composer')).toBeNull()
  })

  it('fits only a live session Caprock started that is not a shell', () => {
    const s = (over: Partial<SessionSummary>) => ({ session_id: 'x', owned: true, status: 'idle', kind: 'agent', ...over }) as SessionSummary
    expect(composerFits(s({}))).toBe(true)
    expect(composerFits(s({ owned: false }))).toBe(false)
    expect(composerFits(s({ kind: 'shell' }))).toBe(false)
    expect(composerFits(s({ status: 'ended' }))).toBe(false)
    expect(composerFits(s({ detached: true }))).toBe(false)
    expect(composerFits(undefined)).toBe(false)
  })

  it('keeps the last 50 messages per session, a repeat of the newest once', () => {
    for (let i = 0; i < HISTORY_MAX + 5; i++) pushHistory('a', `m${i}`)
    pushHistory('a', `m${HISTORY_MAX + 4}`)
    const list = loadHistory('a')
    expect(list).toHaveLength(HISTORY_MAX)
    expect(list[0]).toBe('m5')
    expect(list[list.length - 1]).toBe(`m${HISTORY_MAX + 4}`)
    expect(loadHistory('b')).toEqual([])
  })

  it('walks the history up from the empty box and back down to it', () => {
    const list = ['one', 'two']
    expect(historyStep(list, 2, -1)).toEqual({ at: 1, text: 'two' })
    expect(historyStep(list, 1, -1)).toEqual({ at: 0, text: 'one' })
    expect(historyStep(list, 0, -1)).toBeNull()
    expect(historyStep(list, 1, 1)).toEqual({ at: 2, text: '' })
    expect(historyStep(list, 2, 1)).toBeNull()
    expect(historyStep([], 0, -1)).toBeNull()
  })
})
