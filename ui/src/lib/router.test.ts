import { describe, expect, it } from 'vitest'
import { href, parseHash } from './router'

describe('router', () => {
  it('parses and renders routes symmetrically', () => {
    expect(parseHash('')).toEqual({ name: 'now' })
    expect(parseHash('#/')).toEqual({ name: 'now' })
    // #/now is the whole Now screen, which a phone reaches past its home.
    expect(parseHash('#/now')).toEqual({ name: 'now', full: true })
    expect(href({ name: 'now', full: true })).toBe('#/now')
    expect(href({ name: 'now' })).toBe('#/')
    expect(parseHash('#/cost')).toEqual({ name: 'cost' })
    expect(parseHash('#/session/abc%2Fdef?tab=diff')).toEqual({ name: 'session', id: 'abc/def', tab: 'diff' })
    expect(parseHash('#/nope')).toEqual({ name: 'now' })
    expect(href({ name: 'session', id: 'x y', tab: 'timeline' })).toBe('#/session/x%20y?tab=timeline')
    expect(parseHash(href({ name: 'history' }))).toEqual({ name: 'history' })
    // The Queue is a tab of Tasks with its own address.
    expect(parseHash('#/queue')).toEqual({ name: 'tasks', view: 'queue' })
    expect(href({ name: 'tasks', view: 'queue' })).toBe('#/queue')
    expect(href({ name: 'tasks' })).toBe('#/tasks')
  })
})

describe('a session route can carry a moment', () => {
  // Clicking a minute in the pulse has to land on those events. Opening the
  // session at the top of a thousand-event timeline is the same as not having
  // clicked anything — which is exactly how it read before.
  it('round-trips an instant', () => {
    const at = Date.parse('2026-08-21T02:05:00Z')
    const url = href({ name: 'session', id: 's-1', at })
    expect(url).toContain(`at=${at}`)
    expect(parseHash(url)).toEqual({ name: 'session', id: 's-1', tab: undefined, at })
  })

  it('keeps the tab alongside it', () => {
    const url = href({ name: 'session', id: 's-1', tab: 'diff', at: 1700000000000 })
    const r = parseHash(url)
    expect(r).toMatchObject({ name: 'session', tab: 'diff', at: 1700000000000 })
  })

  it('omits the query entirely when there is nothing to carry', () => {
    expect(href({ name: 'session', id: 's-1' })).toBe('#/session/s-1')
  })

  it('ignores a nonsense instant rather than passing it on', () => {
    for (const bad of ['at=abc', 'at=-5', 'at=0', 'at=']) {
      expect(parseHash(`#/session/s-1?${bad}`)).toMatchObject({ name: 'session', at: undefined })
    }
  })
})

describe('the start-work route', () => {
  it('round-trips each mode and drops an unknown one', () => {
    for (const mode of ['clone', 'new', 'worktree'] as const) {
      expect(parseHash(href({ name: 'start', mode }))).toEqual({ name: 'start', mode })
    }
    expect(parseHash('#/start')).toEqual({ name: 'start' })
    expect(parseHash('#/start?mode=shell')).toEqual({ name: 'start' })
  })
})

describe('the settings route', () => {
  it('deep-links to the phone and to Telegram, and drops an unknown section', () => {
    for (const section of ['phone', 'telegram'] as const) {
      expect(href({ name: 'settings', section })).toBe(`#/settings/${section}`)
      expect(parseHash(href({ name: 'settings', section }))).toEqual({ name: 'settings', section })
    }
    expect(parseHash('#/settings')).toEqual({ name: 'settings' })
    expect(parseHash('#/settings/printer')).toEqual({ name: 'settings' })
  })
})
