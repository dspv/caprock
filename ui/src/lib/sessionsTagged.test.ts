import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { resetMemory } from './memoryResets'

// The session lists are asked again with the tag of the last answer; a 304
// returns the kept answer, the same object, so a caller can skip its work.
describe('session lists by ETag', () => {
  let asked: { url: string; tag: string | null; cache?: RequestCache }[]
  let next: () => Response
  beforeEach(() => {
    resetMemory()
    asked = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>
      asked.push({ url, tag: h['If-None-Match'] ?? null, cache: init?.cache })
      return next()
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const list = (id: string) => JSON.stringify([{ session_id: id }])

  it('sends the last tag and keeps the answer on a 304', async () => {
    next = () => new Response(list('a'), { status: 200, headers: { ETag: '"t1"', 'X-Total-Count': '7' } })
    const first = await api.sessions(false)
    expect(first).toEqual([{ session_id: 'a' }])
    expect(asked[0]).toEqual({ url: '/v1/sessions', tag: null, cache: 'no-store' })

    next = () => new Response(null, { status: 304, headers: { ETag: '"t1"' } })
    const again = await api.sessions(false)
    expect(asked[1]!.tag).toBe('"t1"')
    expect(again).toEqual(first)
    expect(again).not.toBe(first)

    // The live list is another path with its own tag.
    next = () => new Response(list('b'), { status: 200, headers: { ETag: '"t2"' } })
    expect(await api.sessions(true)).toEqual([{ session_id: 'b' }])
    expect(asked[2]).toMatchObject({ url: '/v1/sessions?active=true', tag: null })

    // A changed list replaces the kept one.
    next = () => new Response(list('c'), { status: 200, headers: { ETag: '"t3"' } })
    expect(await api.sessions(false)).toEqual([{ session_id: 'c' }])
    expect(asked[3]!.tag).toBe('"t1"')
    next = () => new Response(null, { status: 304 })
    expect(await api.sessions(false)).toEqual([{ session_id: 'c' }])
    expect(asked[4]!.tag).toBe('"t3"')
  })

  it('leaves the counted lists to the browser: no tag of its own', async () => {
    next = () => new Response(list('a'), { status: 200, headers: { ETag: '"t1"', 'X-Total-Count': '42' } })
    expect((await api.sessionsWithTotal(false, '', 0, 'exclude')).total).toBe(42)
    await api.sessionsWithTotal(false, '', 0, 'exclude')
    expect(asked[1]).toMatchObject({ url: '/v1/sessions?chats=exclude', tag: null })
  })

  it('keeps nothing from an answer without a tag', async () => {
    next = () => new Response(list('a'), { status: 200 })
    await api.sessions(false)
    await api.sessions(false)
    expect(asked[1]!.tag).toBeNull()
  })
})
