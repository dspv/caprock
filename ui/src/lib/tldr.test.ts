import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchTldr, resetTldr, TldrError } from './tldr'

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('AI;DR client', () => {
  beforeEach(() => resetTldr())
  afterEach(() => vi.unstubAllGlobals())

  it('posts an empty JSON body, the relay CSRF proof, and keeps the summary for the page', async () => {
    const fetch = vi.fn(async () => reply(200, { tldr: ' Fixed; push it? ', cached: false }))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchTldr(42)).toBe('Fixed; push it?')
    expect(await fetchTldr(42)).toBe('Fixed; push it?')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/v1/events/42/tldr')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{}')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('shares one request between two taps in flight', async () => {
    const fetch = vi.fn(async () => reply(200, { tldr: 'one', cached: true }))
    vi.stubGlobal('fetch', fetch)
    const [a, b] = await Promise.all([fetchTldr(1), fetchTldr(1)])
    expect([a, b]).toEqual(['one', 'one'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("says the daemon's own error, and asks again after a failure", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply(503, { error: 'no agent CLI can summarise on this machine' }))
      .mockResolvedValueOnce(reply(200, { tldr: 'now it can', cached: false }))
    vi.stubGlobal('fetch', fetch)
    const err = await fetchTldr(9).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TldrError)
    expect((err as TldrError).status).toBe(503)
    expect((err as Error).message).toBe('no agent CLI can summarise on this machine')
    expect(await fetchTldr(9)).toBe('now it can')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('treats a 502 (the agent ran and failed) as an error, its words or else its status', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply(502, { error: 'claude timed out' }))
      .mockResolvedValueOnce(new Response('', { status: 502 })))
    await expect(fetchTldr(3)).rejects.toThrow('claude timed out')
    await expect(fetchTldr(3)).rejects.toThrow(/502/)
  })

  it('says in words what a 403 means', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden origin', { status: 403 })))
    await expect(fetchTldr(6)).rejects.toThrow(/refused to summarise/)
  })

  it('names an unknown answer on a 404 without a body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    await expect(fetchTldr(5)).rejects.toThrow(/not known/)
  })
})
