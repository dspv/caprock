import { afterEach, describe, expect, it, vi } from 'vitest'
import { brainFailureReason, brainRunOutcome, dropIntoBrain } from './brain'

describe('brainFailureReason', () => {
  it.each([
    ['invalid memory\na memory needs a title', 'Claude’s answer could not be saved'],
    ['storing the answer: database is locked', 'Claude’s answer could not be saved'],
    ['claude: exit status 1: Invalid API key · Please run /login', 'Claude Code is not signed in'],
    ['claude: exit status 1: Claude AI usage limit reached|1792700000', 'Claude is at its usage limit'],
    ['claude: exit status 1: API Error: 529 Overloaded', 'Claude is at its usage limit'],
    ['claude: exec: "claude": executable file not found in $PATH', 'Claude Code was not found'],
    ['claude: context deadline exceeded', 'Claude took too long to answer'],
    ['claude: exit status 1: API Error: Connection error. getaddrinfo ENOTFOUND api.anthropic.com', 'Claude could not be reached'],
    ['today\'s token limit is reached; reading resumes as the day rolls over', 'today’s token limit is used'],
    ['context canceled', 'it was stopped before it finished'],
    // Claude Code's JSON result names "usage" and token counts: neither is a limit.
    ['claude: exit status 1: {"usage":{"input_tokens":401,"output_tokens":0}}', 'Claude Code stopped with an error'],
    ['sql: no rows', 'something went wrong'],
  ])('%s', (raw, want) => expect(brainFailureReason(raw)).toBe(want))

  it('says what each read of the list came to', () => {
    expect(brainRunOutcome({ status: 'ok', nodes: 1 })).toBe('1 memory')
    expect(brainRunOutcome({ status: 'failed', nodes: 0, error: 'x' })).toBe('didn’t finish, tried again later')
    expect(brainRunOutcome({ status: 'skipped', nodes: 0, error: 'gave up after repeated failures' })).toBe('given up after 4 tries')
    expect(brainRunOutcome({ status: 'skipped', nodes: 0, error: 'held: too little to read yet' })).toBe('waiting for more')
    expect(brainRunOutcome({ status: 'skipped', nodes: 0 })).toBe('too short')
  })
})

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
