import { describe, expect, it } from 'vitest'
import { href, parseHash } from './router'

describe('router', () => {
  it('parses and renders routes symmetrically', () => {
    expect(parseHash('')).toEqual({ name: 'now' })
    expect(parseHash('#/')).toEqual({ name: 'now' })
    expect(parseHash('#/cost')).toEqual({ name: 'cost' })
    expect(parseHash('#/session/abc%2Fdef?tab=diff')).toEqual({ name: 'session', id: 'abc/def', tab: 'diff' })
    expect(parseHash('#/nope')).toEqual({ name: 'now' })
    expect(href({ name: 'session', id: 'x y', tab: 'timeline' })).toBe('#/session/x%20y?tab=timeline')
    expect(parseHash(href({ name: 'history' }))).toEqual({ name: 'history' })
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
