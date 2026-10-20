import { beforeEach, describe, expect, it } from 'vitest'
import { rememberedViews, rememberView, viewOf, VIEW_KEEP } from './sessionView'

beforeEach(() => localStorage.clear())

describe('how a session tab is shown', () => {
  it('opens a chat on Chat and a project session on Terminal until a choice is made', () => {
    expect(viewOf(undefined, true)).toBe('chat')
    expect(viewOf(undefined, false)).toBe('terminal')
    expect(viewOf('terminal', true)).toBe('terminal')
    expect(viewOf('chat', false)).toBe('chat')
  })

  it('remembers the choice per session, the newest last', () => {
    rememberView('a', 'chat')
    rememberView('b', 'terminal')
    rememberView('a', 'terminal')
    expect(rememberedViews()).toEqual({ a: 'terminal', b: 'terminal' })
    expect(Object.keys(JSON.parse(localStorage.getItem('caprock.app.session-view')!) as object)).toEqual(['b', 'a'])
  })

  it('forgets the oldest choices past the cap, and ignores what it cannot read', () => {
    for (let i = 0; i < VIEW_KEEP + 5; i++) rememberView(`s${i}`, 'chat')
    const all = rememberedViews()
    expect(Object.keys(all)).toHaveLength(VIEW_KEEP)
    expect(all.s0).toBeUndefined()
    expect(all[`s${VIEW_KEEP + 4}`]).toBe('chat')
    localStorage.setItem('caprock.app.session-view', '{"x":"pane","y":"chat"}')
    expect(rememberedViews()).toEqual({ y: 'chat' })
    localStorage.setItem('caprock.app.session-view', 'not json')
    expect(rememberedViews()).toEqual({})
  })
})
