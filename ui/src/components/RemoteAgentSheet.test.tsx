/**
 * New agent on another computer (ADR-067, Phase 2): the Machine picker, the
 * folders and agents read from that computer, the start through the proxy,
 * and the errors in words.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { NewAgentSheet } from './NewAgentSheet'
import { machineStartable, remoteStartError } from './RemoteAgentSheet'
import type { Machine } from '@/lib/machines'

const ID = 'f7kc4QaG4HRPYEjg19Pr-au-FeTljmKHkikFrAmRTzM'
const mini: Machine = { id: ID, name: 'Mac mini', relay: 'wss://relay.example', added_at: 1, status: 'online', kind: 'machine', role: 'controller', streams: 0 }
const box: Machine = { ...mini, id: `${ID.slice(0, -1)}B`, name: 'Linux box', status: 'pending' }

type Reply = { status?: number; body: unknown }
function stubFetch(routes: Record<string, Reply | ((init?: RequestInit) => Reply)>) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const key = Object.keys(routes).find((k) => url.startsWith(k))
    const r = key ? routes[key] : undefined
    const reply = typeof r === 'function' ? r(init) : r ?? { status: 404, body: { error: 'not here' } }
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }))
  return calls
}

const far = `/v1/m/${encodeURIComponent(ID)}`
const homeRoutes = (start: Reply | ((init?: RequestInit) => Reply)) => ({
  '/v1/machines/sessions': { body: { machines: [{ id: ID, name: 'Mac mini', status: 'online', sessions: [] }, { id: box.id, name: 'Linux box', status: 'pending' }] } },
  '/v1/machines': { body: { machines: [mini, box] } },
  [`${far}/v1/projects`]: { body: { projects: [{ id: 1, root: '/home/me/api', name: 'api', kind: 'repo' }] } },
  [`${far}/v1/recent-dirs`]: { body: [{ dir: '/home/me/site', name: 'site', sessions: 2, last_event_at: 1 }] },
  [`${far}/v1/agents/catalog`]: { body: { licensed: false, agents: [{ id: 'claude', label: 'Claude Code', installed: true, ready: true, models: [], observed: true, prompt: true }, { id: 'codex', label: 'Codex', installed: true, ready: true, models: [], observed: true, prompt: true }] } },
  [`${far}/v1/browse/stat`]: { body: { path: '/home/me/api', exists: true, is_dir: true } },
  [`${far}/v1/agents`]: start,
})

describe('New agent on another computer', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('offers This Mac and each computer, disabled with why when it cannot start one', async () => {
    stubFetch(homeRoutes({ body: {} }))
    render(<NewAgentSheet projects={[]} onClose={vi.fn()} onStarted={vi.fn()} />)
    const picker = await screen.findByRole('combobox', { name: 'Machine' })
    const options = [...(picker as HTMLSelectElement).options].map((o) => [o.textContent, o.disabled])
    expect(options[0]?.[1]).toBe(false)
    expect(options.slice(1)).toEqual([['Mac mini', false], ['Linux box · waiting for Allow', true]])
  })

  it('reads folders and agents from that computer and starts there, through the proxy', async () => {
    const started = vi.fn()
    let sent: Record<string, unknown> = {}
    const calls = stubFetch(homeRoutes((init) => { sent = JSON.parse(String(init?.body)); return { body: { session_id: 'far-1', cwd: '/home/me/api' } } }))
    render(<NewAgentSheet projects={[]} onClose={vi.fn()} onStarted={vi.fn()} onStartedOn={started} />)
    fireEvent.change(await screen.findByRole('combobox', { name: 'Machine' }), { target: { value: ID } })
    expect(await screen.findByText('New agent on Mac mini')).toBeTruthy()
    const folder = await screen.findByRole('combobox', { name: 'Folder on Mac mini' })
    await waitFor(() => expect((folder as HTMLInputElement).value).toBe('/home/me/api'))
    expect([...document.querySelectorAll(`#remote-folders-${CSS.escape(ID)} option`)].map((o) => o.getAttribute('value'))).toEqual(['/home/me/api', '/home/me/site'])
    await screen.findByText('on Mac mini') // the folder is there
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'codex' } })
    fireEvent.change(screen.getByPlaceholderText('What should it do?'), { target: { value: 'fix the tests' } })
    fireEvent.click(screen.getByRole('button', { name: /Start/ }))
    await waitFor(() => expect(started).toHaveBeenCalledWith(ID, 'far-1', 'fix the tests'))
    expect(sent).toMatchObject({ cwd: '/home/me/api', agent: 'codex', prompt: 'fix the tests' })
    expect(calls.find((c) => c.url === `${far}/v1/agents`)?.init?.method).toBe('POST')
    // Nothing of it reached this computer's own start.
    expect(calls.some((c) => c.url === '/v1/agents')).toBe(false)
  })

  it('says offline in words when the computer went away', async () => {
    stubFetch(homeRoutes({ status: 503, body: { error: 'the computer is offline: not at the relay', status: 'offline' } }))
    render(<NewAgentSheet projects={[]} onClose={vi.fn()} onStarted={vi.fn()} />)
    fireEvent.change(await screen.findByRole('combobox', { name: 'Machine' }), { target: { value: ID } })
    const folder = await screen.findByRole('combobox', { name: 'Folder on Mac mini' })
    await waitFor(() => expect((folder as HTMLInputElement).value).toBe('/home/me/api'))
    fireEvent.click(screen.getByRole('button', { name: /Start/ }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/^Mac mini is offline\. It is not at its relay/)
  })

  it('words every refusal for a person', () => {
    const e = (status: number, body: unknown) => new ApiError(status, String(status), body)
    expect(remoteStartError(e(400, { error: 'cwd "/x" is not a directory' }), 'Mac mini')).toBe('That folder is not on Mac mini. Pick one of its folders, or create it there first.')
    expect(remoteStartError(e(403, { error: 'this computer is waiting to be allowed on the machine Caprock runs on' }), 'Mac mini')).toMatch(/has not allowed this computer yet/)
    expect(remoteStartError(e(403, { error: 'x', status: 'revoked' }), 'Mac mini')).toMatch(/removed this computer/)
    expect(remoteStartError(e(409, { error: 'consent', code: 'bypass_consent' }), 'Mac mini')).toMatch(/one-time warning/)
    expect(machineStartable(mini, { id: ID, name: 'Mac mini', status: 'offline' })).toEqual({ ok: false, why: 'offline' })
    expect(machineStartable({ ...mini, status: 'idle' })).toEqual({ ok: true })
  })
})
