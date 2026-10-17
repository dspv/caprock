import { describe, expect, it } from 'vitest'
import { href, parseHash } from './router'
import { keptScreen } from './screenPlace'

describe('router', () => {
  it('parses and renders routes symmetrically', () => {
    expect(parseHash('')).toEqual({ name: 'now' })
    expect(parseHash('#/')).toEqual({ name: 'now' })
    // #/home is the whole Home screen, which a phone reaches past its home;
    // #/now, its name until 2026-10-14, still opens it.
    expect(parseHash('#/home')).toEqual({ name: 'now', full: true })
    expect(parseHash('#/now')).toEqual({ name: 'now', full: true })
    expect(href({ name: 'now', full: true })).toBe('#/home')
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
  it('deep-links to the phone, Telegram and the computers, and drops an unknown section', () => {
    for (const section of ['phone', 'telegram', 'computers'] as const) {
      expect(href({ name: 'settings', section })).toBe(`#/settings/${section}`)
      expect(parseHash(href({ name: 'settings', section }))).toEqual({ name: 'settings', section })
    }
    expect(parseHash('#/settings')).toEqual({ name: 'settings' })
    expect(parseHash('#/settings/printer')).toEqual({ name: 'settings' })
  })
})

describe('the Work and Pipeline routes', () => {
  it('opens Work at #/work, kept like the other dashboard screens', () => {
    expect(href({ name: 'work' })).toBe('#/work')
    expect(parseHash('#/work')).toEqual({ name: 'work' })
    expect(keptScreen({ name: 'work' })).toBe('work')
  })

  it('carries a pull request to open in the Pipeline, and drops a nonsense one', () => {
    const h = href({ name: 'pipeline', repo: '/w/app', pr: 641 })
    expect(h).toBe('#/pipeline?repo=%2Fw%2Fapp&pr=641')
    expect(parseHash(h)).toEqual({ name: 'pipeline', repo: '/w/app', pr: 641 })
    for (const bad of ['pr=abc', 'pr=-1', 'pr=0', 'pr=1.5']) {
      expect(parseHash(`#/pipeline?repo=x&${bad}`)).toEqual({ name: 'pipeline', repo: 'x' })
    }
  })
})

describe('chats (ADR-071)', () => {
  it('round-trips the list, its archived half and one chat', () => {
    for (const r of [{ name: 'chats' }, { name: 'chats', archived: true }, { name: 'chat', id: 'a b/c' }] as const) {
      expect(parseHash(href(r))).toEqual(r)
    }
    expect(href({ name: 'chat', id: 'c1' })).toBe('#/chats/c1')
    expect(parseHash('#/chats?archived=0')).toEqual({ name: 'chats' })
  })
})

describe('another computer (ADR-067)', () => {
  const id = 'f7kc4QaG4HRPYEjg19Pr-au-FeTljmKHkikFrAmRTzM'
  it('round-trips its sessions and one of them, with the tab', () => {
    for (const r of [
      { name: 'machine' as const, id },
      { name: 'machine' as const, id, session: 'a b' },
      { name: 'machine' as const, id, session: 's1', tab: 'terminal' },
    ]) expect(parseHash(href(r))).toEqual(r)
    expect(href({ name: 'machine', id, session: 's1' })).toBe(`#/m/${id}/session/s1`)
  })
  it('sends a malformed id home', () => {
    expect(parseHash('#/m/../etc')).toEqual({ name: 'now' })
    expect(parseHash('#/m/')).toEqual({ name: 'now' })
  })
})
