import { afterEach, describe, expect, it, vi } from 'vitest'
import { dropIntoBrain } from './brain'

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('dropIntoBrain', () => {
  it('tries a drop again while the database is busy', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(answer(503, { error: 'the database is busy', detail: 'nothing was saved; try again in a moment' }))
      .mockResolvedValueOnce(answer(200, { node: { id: 7, title: 'kept' }, created: true }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await dropIntoBrain({ text: 'kept' }, 1)
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('says in words why a drop failed once the retries run out', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      answer(503, { error: 'the database is busy', detail: 'nothing was saved; try again in a moment' }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await dropIntoBrain({ text: 'kept' }, 1)
    expect(r).toEqual({ ok: false, message: 'the database is busy — nothing was saved; try again in a moment' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('does not retry a request the daemon refused', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer(400, { error: 'there is nothing to keep: give text or a title' }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await dropIntoBrain({ text: '' }, 1)
    expect(r.ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
