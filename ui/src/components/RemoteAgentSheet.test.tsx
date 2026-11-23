/**
 * New agent on another computer (ADR-067, Phase 2): the Machine picker, the
 * folders and agents read from that computer, the start through the proxy,
 * and the errors in words.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    const folder = await screen.findByRole('textbox', { name: 'Folder on Mac mini' })
    await waitFor(() => expect((folder as HTMLInputElement).value).toBe('/home/me/api'))
    // Its projects, then its recent folders, listed under the field.
    await waitFor(() => expect([...document.querySelectorAll('[data-remote-folder] li button span[title]')].map((s) => s.getAttribute('title'))).toEqual(['/home/me/api', '/home/me/site']))
    await screen.findByText('found there') // the folder is there
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'codex' } })
    fireEvent.change(screen.getByPlaceholderText('What should it do?'), { target: { value: 'fix the tests' } })
    fireEvent.click(screen.getByRole('button', { name: /Start/ }))
    await waitFor(() => expect(started).toHaveBeenCalledWith(ID, 'far-1', 'fix the tests'))
    expect(sent).toMatchObject({ cwd: '/home/me/api', agent: 'codex', prompt: 'fix the tests' })
    expect(calls.find((c) => c.url === `${far}/v1/agents`)?.init?.method).toBe('POST')
    // Nothing of it reached this computer's own start.
    expect(calls.some((c) => c.url === '/v1/agents')).toBe(false)
  })

  // A computer with Caprock and no agent yet: the field said "reading…" for
  // good, which reads as a link that hangs.
  it('says so when no agent is installed on that computer, and does not start', async () => {
    stubFetch({ ...homeRoutes({ body: {} }), [`${far}/v1/agents/catalog`]: { body: { licensed: false, agents: [{ id: 'claude', label: 'Claude Code', installed: false, ready: false, models: [], observed: true, prompt: true }] } } })
    render(<NewAgentSheet projects={[]} onClose={vi.fn()} onStarted={vi.fn()} onStartedOn={vi.fn()} />)
    fireEvent.change(await screen.findByRole('combobox', { name: 'Machine' }), { target: { value: ID } })
    expect(await screen.findByText(/No agent is installed on Mac mini/)).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Agent' }).textContent).toBe('none installed there')
    expect((screen.getByRole('button', { name: /Start/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says offline in words when the computer went away', async () => {
    stubFetch(homeRoutes({ status: 503, body: { error: 'the computer is offline: not at the relay', status: 'offline' } }))
    render(<NewAgentSheet projects={[]} onClose={vi.fn()} onStarted={vi.fn()} />)
    fireEvent.change(await screen.findByRole('combobox', { name: 'Machine' }), { target: { value: ID } })
    const folder = await screen.findByRole('textbox', { name: 'Folder on Mac mini' })
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

// The owner's Windows PC, 2026-11-20: a fresh computer with no projects, an
// empty Folder field, and Start wrapped under Cancel.
describe('New agent on a Windows PC: the folder is chosen, not typed', () => {
  const PC = 'DESKTOP-O0QL9JF'
  const pc: Machine = { ...mini, name: PC }
  const HOME = 'C:\\Users\\me'
  const DEV = `${HOME}\\dev`
  const listing = (dir: string): Reply => {
    if (dir === '' || dir === HOME) return { body: { dir: HOME, parent: '', root: HOME, entries: [{ name: 'dev', path: DEV, repo: false }, { name: 'Downloads', path: `${HOME}\\Downloads`, repo: false }] } }
    if (dir === '~/dev' || dir === DEV) return { body: { dir: DEV, parent: HOME, root: HOME, entries: [{ name: 'api', path: `${DEV}\\api`, repo: true }] } }
    if (dir === `${DEV}\\api`) return { body: { dir: `${DEV}\\api`, parent: DEV, root: HOME, entries: [] } }
    return { status: 404, body: { error: 'not found' } }
  }

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** That computer's answers; `extra` sees every request first. */
  function stubPC(opts: { projects?: unknown[]; recent?: unknown[]; extra?: (path: string, init?: RequestInit) => Reply | undefined } = {}) {
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      const reply = ((): Reply => {
        if (url.startsWith('/v1/machines/sessions')) return { body: { machines: [{ id: ID, name: PC, status: 'online', sessions: [] }] } }
        if (url.startsWith('/v1/machines')) return { body: { machines: [pc] } }
        if (!url.startsWith(far)) return { status: 404, body: {} }
        const path = url.slice(far.length)
        const hit = opts.extra?.(path, init)
        if (hit) return hit
        const [route, query = ''] = path.split('?')
        const q = new URLSearchParams(query)
        if (route === '/v1/projects') return { body: { projects: opts.projects ?? [] } }
        if (route === '/v1/recent-dirs') return { body: opts.recent ?? [] }
        if (route === '/v1/agents/catalog') return { body: { licensed: false, home: HOME, agents: [{ id: 'claude', label: 'Claude Code', installed: true, ready: true, models: [], observed: true, prompt: true }] } }
        if (route === '/v1/browse/stat') return { body: { path: q.get('path'), exists: true, is_dir: true } }
        if (route === '/v1/browse') return listing(q.get('dir') ?? '')
        return { status: 404, body: { error: 'not here' } }
      })()
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } })
    }))
    return calls
  }

  async function open() {
    render(<NewAgentSheet projects={[]} onClose={vi.fn()} onStarted={vi.fn()} onStartedOn={vi.fn()} machine={ID} />)
    return (await screen.findByRole('textbox', { name: `Folder on ${PC}` })) as HTMLInputElement
  }

  it('lists the folders on that computer, as it writes them', async () => {
    stubPC({ projects: [{ id: 1, root: `${DEV}\\api`, name: 'api' }], recent: [{ dir: `${DEV}\\site`, name: 'site', sessions: 1, last_event_at: Date.now() }] })
    const field = await open()
    await waitFor(() => expect(field.value).toBe(`${DEV}\\api`))
    await waitFor(() => expect([...document.querySelectorAll('[data-remote-folder] li button span[title]')].map((s) => s.getAttribute('title'))).toEqual([`${DEV}\\api`, `${DEV}\\site`]))
    fireEvent.click(screen.getByText('site'))
    expect(field.value).toBe(`${DEV}\\site`)
    expect(screen.queryByText(new RegExp(`No projects on ${PC}`))).toBeNull()
  })

  it('browses its folders from its dev folder: a click opens one and picks it, the breadcrumb goes back', async () => {
    const calls = stubPC({ projects: [{ id: 1, root: `${DEV}\\api`, name: 'api' }] })
    const field = await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Browse' }))
    const list = await screen.findByRole('listbox', { name: 'Folders' })
    // Opened in ~/dev, read through the proxy, spelled as that computer spells it.
    expect(calls.some((c) => c.url === `${far}/v1/browse?dir=${encodeURIComponent('~/dev')}`)).toBe(true)
    fireEvent.click(await within(list).findByText('api'))
    await waitFor(() => expect(field.value).toBe(`${DEV}\\api`))
    await waitFor(() => expect(calls.some((c) => c.url === `${far}/v1/browse?dir=${encodeURIComponent(`${DEV}\\api`)}`)).toBe(true))
    fireEvent.click(await screen.findByRole('button', { name: '~' }))
    await waitFor(() => expect(field.value).toBe(HOME))
    expect(await within(list).findByText('Downloads')).toBeTruthy()
  })

  it('with no projects there, says so and offers Clone a repository and Pick a folder', async () => {
    stubPC()
    await open()
    const empty = await screen.findByRole('group', { name: `No projects on ${PC}` })
    expect(empty.textContent).toContain(`No projects on ${PC} yet.`)
    expect(within(empty).getByRole('button', { name: 'Clone a repository' })).toBeTruthy()
    fireEvent.click(within(empty).getByRole('button', { name: 'Pick a folder' }))
    expect(await screen.findByRole('listbox', { name: 'Folders' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Browse' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('clones into its dev folder through that computer, and picks the new folder when done', async () => {
    let sent: Record<string, unknown> | null = null
    const calls = stubPC({
      extra: (path, init) => {
        if (path === '/v1/projects' && init?.method === 'POST') {
          sent = JSON.parse(String(init.body)) as Record<string, unknown>
          return { status: 202, body: { op: { op_id: sent.op_id, state: 'running', phase: 'Receiving objects', progress: 40 }, existing: false } }
        }
        if (path === '/v1/projects/ops') {
          return { body: { ops: sent ? [{ op_id: sent.op_id, state: 'done', dest: `${DEV}\\caprock`, project_id: 7 }] : [] } }
        }
        return undefined
      },
    })
    const field = await open()
    fireEvent.click(within(await screen.findByRole('group', { name: `No projects on ${PC}` })).getByRole('button', { name: 'Clone a repository' }))
    const url = await screen.findByRole('textbox', { name: 'Repository address' })
    fireEvent.change(url, { target: { value: 'https://github.com/dspv/caprock.git' } })
    // Where it lands, in full, before anything runs.
    await waitFor(() => expect(document.querySelector('[data-clone-dest]')?.textContent).toBe(`${DEV}\\caprock`))
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    await waitFor(() => expect(sent).toMatchObject({ clone: { url: 'https://github.com/dspv/caprock.git', parent: DEV } }))
    expect(typeof sent!.op_id).toBe('string')
    await waitFor(() => expect(field.value).toBe(`${DEV}\\caprock`), { timeout: 4000 })
    // Listed first under Projects, before its project is read back.
    expect(screen.getByRole('button', { name: 'Projects' }).getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[data-remote-folder] li button span[title]')?.getAttribute('title')).toBe(`${DEV}\\caprock`)
    // Through the proxy, never this computer's own projects.
    expect(calls.some((c) => c.url === '/v1/projects')).toBe(false)
  })

  it('says a refused clone in words', async () => {
    stubPC({ extra: (path, init) => (path === '/v1/projects' && init?.method === 'POST' ? { status: 400, body: { error: 'destination already exists' } } : path === '/v1/projects/ops' ? { body: { ops: [] } } : undefined) })
    await open()
    fireEvent.click(within(await screen.findByRole('group', { name: `No projects on ${PC}` })).getByRole('button', { name: 'Clone a repository' }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Repository address' }), { target: { value: 'not a url' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Paste an https:// address, or git@host:owner/repo.')
    fireEvent.change(screen.getByRole('textbox', { name: 'Repository address' }), { target: { value: 'https://github.com/dspv/caprock.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    expect((await screen.findByText(/^Clone failed:/)).textContent).toBe('Clone failed: destination already exists')
  })

  it('keeps Cancel and Start on one row: the line beside them gives way, never the buttons', async () => {
    stubPC({ projects: [{ id: 1, root: `${DEV}\\api`, name: 'api' }] })
    await open()
    const note = document.querySelector('[data-sheet-note]')!
    expect(note.textContent).toBe(`Runs on ${PC}`)
    // flex-basis 0 with min-width 0: the note never takes the room the
    // buttons need, so the footer's wrap never moves Start.
    for (const c of ['flex-1', 'basis-0', 'min-w-0', 'truncate']) expect(note.classList.contains(c)).toBe(true)
    const cancel = screen.getByRole('button', { name: /Cancel/ })
    const start = screen.getByRole('button', { name: /Start/ })
    expect(cancel.parentElement).toBe(note.parentElement)
    expect(start.parentElement).toBe(note.parentElement)
    for (const b of [cancel, start]) for (const c of ['shrink-0', 'whitespace-nowrap']) expect(b.classList.contains(c)).toBe(true)
  })
})

// The owner's Windows PC, 2026-11-23: Model was a bare "its default" field,
// because Claude Code's list is the page's own and never in a catalog. And
// Effort at start, read from that computer's catalog.
describe('New agent on another computer: model and effort', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    try { localStorage.clear() } catch { /* none */ }
  })
  const claude = {
    id: 'claude', label: 'Claude Code', installed: true, ready: true, models: [], observed: true, prompt: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    model_efforts: { 'claude-opus-5-5': 'high', 'claude-sonnet-5-5': 'medium', 'claude-haiku-5-5': 'medium', 'claude-fable-5-2': 'medium' },
  }
  const codex = { id: 'codex', label: 'Codex', installed: true, ready: true, models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }, { id: 'gpt-6-sol', label: 'GPT-6-Sol' }], default: 'gpt-6-astra', observed: true, prompt: true, efforts: ['low', 'medium', 'high', 'xhigh'], effort_default: 'xhigh' }
  const gemini = { id: 'gemini', label: 'Gemini CLI', installed: true, ready: true, models: [], observed: true, prompt: true }
  const setup = () => {
    let sent: Record<string, unknown> = {}
    stubFetch({
      ...homeRoutes((init) => { sent = JSON.parse(String(init?.body)); return { body: { session_id: 'far-1', cwd: '/home/me/api' } } }),
      [`${far}/v1/agents/catalog`]: { body: { licensed: false, agents: [claude, codex, gemini] } },
    })
    render(<NewAgentSheet projects={[]} onClose={vi.fn()} onStarted={vi.fn()} onStartedOn={vi.fn()} />)
    return { sent: () => sent }
  }
  const open = async () => {
    fireEvent.change(await screen.findByRole('combobox', { name: 'Machine' }), { target: { value: ID } })
    const folder = await screen.findByRole('textbox', { name: 'Folder on Mac mini' })
    await waitFor(() => expect((folder as HTMLInputElement).value).toBe('/home/me/api'))
  }
  const effortGroup = () => screen.queryByRole('radiogroup', { name: 'Effort' })
  const checked = () => within(effortGroup()!).getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true')?.getAttribute('data-effort')
  const marked = () => within(effortGroup()!).getAllByRole('radio').filter((r) => r.hasAttribute('data-default')).map((r) => r.getAttribute('data-effort'))

  it('offers Claude Code the local list of models, and its default effort for the model chosen', async () => {
    setup()
    await open()
    const model = await screen.findByRole('combobox', { name: 'Model' }) as HTMLSelectElement
    await waitFor(() => expect(model.value).toBe('claude-opus-5-5'))
    expect([...model.options].map((o) => o.value)).toEqual(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
    await waitFor(() => expect(checked()).toBe('high'))
    expect(marked()).toEqual(['high'])
    // The default moves with the model.
    fireEvent.change(model, { target: { value: 'claude-sonnet-5-5' } })
    expect(checked()).toBe('medium')
    expect(marked()).toEqual(['medium'])
  })

  it('passes nothing for the default, and the level picked otherwise', async () => {
    const s = setup()
    await open()
    await waitFor(() => expect(checked()).toBe('high'))
    fireEvent.click(screen.getByRole('button', { name: /Start/ }))
    await waitFor(() => expect(s.sent().cwd).toBe('/home/me/api'))
    expect(s.sent()).toMatchObject({ model: 'claude-opus-5-5' })
    expect('effort' in s.sent()).toBe(false)
  })

  it('sends a different pick, and keeps it for the next start of that agent', async () => {
    const s = setup()
    await open()
    await waitFor(() => expect(checked()).toBe('high'))
    fireEvent.click(within(effortGroup()!).getByRole('radio', { name: 'max' }))
    expect(checked()).toBe('max')
    fireEvent.click(screen.getByRole('button', { name: /Start/ }))
    await waitFor(() => expect(s.sent().effort).toBe('max'))
    expect(JSON.parse(localStorage.getItem('caprock.spawn.effort') ?? '{}')).toEqual({ claude: 'max' })
  })

  it('uses the effort the agent sets for every model, and hides Effort for an agent with none', async () => {
    setup()
    await open()
    const agent = screen.getByRole('combobox', { name: 'Agent' }) as HTMLSelectElement
    await waitFor(() => expect(agent.options.length).toBe(3))
    fireEvent.change(agent, { target: { value: 'codex' } })
    await waitFor(() => expect(checked()).toBe('xhigh'))
    expect(within(effortGroup()!).getAllByRole('radio').map((r) => r.getAttribute('data-effort'))).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect([...(screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).options].map((o) => o.value)).toEqual(['', 'gpt-6-sol'])
    fireEvent.change(agent, { target: { value: 'gemini' } })
    expect(effortGroup()).toBeNull()
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('gemini-3.5-flash-lite')
  })
})
