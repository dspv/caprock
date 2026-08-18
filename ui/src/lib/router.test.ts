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
