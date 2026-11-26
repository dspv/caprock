/**
 * A start that ends at once is said (#1086): the watch asks the computer the
 * session runs on, and announces an early exit — only an early one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onStartExit, watchStart, type StartExit } from './startwatch'

const ID = 'f7kc4QaG4HRPYEjg19Pr-au-FeTljmKHkikFrAmRTzM'

function replies(...rs: { status: number; body?: unknown }[]) {
  const urls: string[] = []
  const f = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input))
    const r = rs.length > 1 ? rs.shift()! : rs[0]!
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status })
  })
  return { f: f as unknown as typeof fetch, urls }
}

describe('watchStart', () => {
  afterEach(() => { vi.useRealTimers() })

  it('asks that computer until the exit, and announces one that was early', async () => {
    vi.useFakeTimers()
    const heard: StartExit[] = []
    const off = onStartExit((e) => heard.push(e))
    const exit = { session_id: 's1', agent: 'claude', code: 0, early: true, ran_ms: 8000, tail: 'WARNING: Claude Code running in Bypass Permissions mode', at: 1 }
    const { f, urls } = replies({ status: 409, body: { error: 'running' } }, { status: 404 }, { status: 200, body: exit })
    watchStart({ machine: ID, name: 'Windows PC', sessionId: 's1' }, { fetch: f, every: 100, within: 10_000 })
    await vi.advanceTimersByTimeAsync(350)
    off()
    expect(urls[0]).toBe(`/v1/m/${ID}/v1/agents/s1/exit`)
    expect(urls).toHaveLength(3)
    expect(heard).toEqual([{ machine: ID, name: 'Windows PC', sessionId: 's1', report: exit }])
    // Nothing more is asked once it is read.
    await vi.advanceTimersByTimeAsync(1000)
    expect(urls).toHaveLength(3)
  })

  it('says nothing of an exit somebody made, and stops after its window', async () => {
    vi.useFakeTimers()
    const heard: StartExit[] = []
    const off = onStartExit((e) => heard.push(e))
    const late = replies({ status: 200, body: { session_id: 's2', code: 0, early: false, ran_ms: 9000, tail: '', at: 1 } })
    watchStart({ machine: '', name: '', sessionId: 's2' }, { fetch: late.f, every: 100, within: 10_000 })
    await vi.advanceTimersByTimeAsync(150)
    expect(late.urls).toEqual(['/v1/agents/s2/exit'])
    const running = replies({ status: 409 })
    watchStart({ machine: ID, name: 'PC', sessionId: 's3' }, { fetch: running.f, every: 100, within: 500 })
    await vi.advanceTimersByTimeAsync(2000)
    off()
    expect(heard).toEqual([])
    expect(running.urls.length).toBeLessThanOrEqual(5)
  })
})
