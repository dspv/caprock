import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RemoteSetup } from './RemoteSetup'
import { AppActionsContext, type SetupReport } from '@/lib/setup'
import { remoteSteps, stepCounts, type SetupRun } from '@/lib/remotesetup'

const ID = 'winPC1000000000000000000000000000000000000AB'

// The owner's Windows PC on 2026-11-26: Git and Claude Code there, nothing
// else of what he walked to it for.
const pc: SetupReport = {
  os: 'windows',
  items: [
    { key: 'git', state: 'ok', label: 'Git', detail: 'Installed.' },
    { key: 'agent', state: 'ok', label: 'Agents', detail: 'Claude Code ready.' },
    { key: 'link', state: 'ok', label: 'Link to your laptop', detail: 'MacBook can start agents here.' },
    { key: 'project', state: 'not_needed', label: 'Projects here', detail: 'Optional.', optional: true },
  ],
  agents: [
    { id: 'claude', label: 'Claude Code', on: true, state: 'ok', detail: 'Signed in. Ready.' },
    { id: 'codex', label: 'Codex', on: false, state: 'not_needed', detail: 'Off.' },
  ],
  tools: [
    { id: 'node', label: 'Node.js', state: 'missing', detail: 'Install runs winget there.', command: 'winget install --id OpenJS.NodeJS.LTS -e --source winget' },
    { id: 'gh', label: 'GitHub CLI', state: 'ok', detail: 'Installed.' },
    { id: 'gh_auth', label: 'Sign in to GitHub', state: 'missing', detail: 'By a one-time code.', command: 'gh auth login --web' },
    { id: 'bypass', label: 'Bypass warning', state: 'missing', detail: 'Claude Code asks once.' },
    { id: 'chrome_default', label: 'Claude in Chrome on by default', state: 'missing', detail: 'Enabled by default.' },
  ],
}

const allDone: SetupReport = { ...pc, tools: pc.tools!.map((t) => ({ ...t, state: 'ok' as const, command: undefined })) }

describe('remoteSteps', () => {
  it('lists Git, the agents switched on, the tools and the two steps of its own screen, in order', () => {
    const steps = remoteSteps(pc)
    expect(steps.map((s) => s.key)).toEqual(['git', 'agent:claude', 'node', 'gh', 'gh_auth', 'bypass', 'chrome_default', 'chrome_extension', 'site_sign_ins'])
    expect(stepCounts(steps)).toEqual({ done: 3, total: 9, left: 6 })
    expect(steps.find((s) => s.key === 'node')?.action).toEqual({ kind: 'run', step: 'node', word: 'Install' })
    expect(steps.find((s) => s.key === 'gh_auth')?.action).toEqual({ kind: 'run', step: 'gh_auth', word: 'Sign in' })
    expect(steps.filter((s) => s.screen).map((s) => s.key)).toEqual(['chrome_extension', 'site_sign_ins'])
  })

  it('counts marks kept here and runs there', () => {
    const runs: SetupRun[] = [{ key: 'node', step: 'node', shell: 'sh-1', state: 'running', line: '45%', started_at: 1 }]
    const steps = remoteSteps(pc, ['chrome_extension'], runs)
    expect(steps.find((s) => s.key === 'node')?.mark).toBe('running')
    expect(steps.find((s) => s.key === 'chrome_extension')?.mark).toBe('done')
    // A run of a step since done is not drawn over it.
    expect(remoteSteps(allDone, [], runs).find((s) => s.key === 'node')?.mark).toBe('done')
  })

  it('leaves out what an older Caprock there does not report, and Chrome without Claude Code', () => {
    const old: SetupReport = { ...pc, tools: undefined }
    expect(remoteSteps(old).map((s) => s.key)).toEqual(['git', 'agent:claude'])
    const noClaude: SetupReport = { ...pc, tools: pc.tools!.filter((t) => t.id !== 'bypass' && t.id !== 'chrome_default') }
    expect(remoteSteps(noClaude).some((s) => s.screen)).toBe(false)
  })

  it('makes an agent sign-in open its terminal', () => {
    const r: SetupReport = { ...pc, agents: [{ id: 'claude', label: 'Claude Code', on: true, state: 'missing', step: 'signin', detail: 'Not signed in.', command: 'claude auth login' }] }
    expect(remoteSteps(r).find((s) => s.key === 'agent:claude')?.action).toEqual({ kind: 'run', step: 'agent', agent: 'claude', word: 'Sign in', signin: true })
  })
})

type Handler = (method: string, path: string, body: unknown) => unknown

function answer(by: Handler) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = new URL(String(input), 'http://x')
    const path = u.pathname.replace(/^\/v1\/m\/[^/]+/, '')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const out = by(init?.method ?? 'GET', path, body)
    return out === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(out), { status: 200 })
  })
}

describe('Set up this computer', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('runs a step there only on its click, and shows the device code with Copy and open', async () => {
    let runs: SetupRun[] = []
    const posted: unknown[] = []
    answer((method, path, body) => {
      if (path === '/v1/setup') return pc
      if (path === '/v1/setup/runs') return { runs }
      if (path === '/v1/setup/run' && method === 'POST') {
        posted.push(body)
        runs = [{ key: 'gh_auth', step: 'gh_auth', shell: 'sh-9', state: 'running', line: 'Press Enter to open github.com in your browser...', code: 'AB12-CD34', started_at: 1 }]
        return runs[0]
      }
      return undefined
    })
    render(<RemoteSetup m={{ id: ID, name: 'Win PC1' }} />)
    const section = await screen.findByRole('region', { name: 'Set up this computer' })
    expect(section).toHaveTextContent('3 of 9 done · each step runs there when you click it')
    expect(posted).toEqual([])
    const row = section.querySelector('[data-remote-step="gh_auth"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(row.querySelector('[data-device-code-value]')).toHaveTextContent('AB12-CD34'))
    expect(posted).toEqual([{ step: 'gh_auth' }])
    expect(row).toHaveAttribute('data-mark', 'running')
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    fireEvent.click(within(row).getByRole('button', { name: 'Copy and open' }))
    expect(open).toHaveBeenCalledWith('https://github.com/login/device', '_blank', 'noopener')
  })

  it('opens a run’s shell as a tab here with Show output', async () => {
    const runs: SetupRun[] = [{ key: 'node', step: 'node', shell: 'sh-3', state: 'running', line: '██ 45%', started_at: 1 }]
    answer((_m, path) => (path === '/v1/setup' ? pc : path === '/v1/setup/runs' ? { runs } : undefined))
    const openRemote = vi.fn()
    render(<AppActionsContext.Provider value={{ openRemote }}><RemoteSetup m={{ id: ID, name: 'Win PC1' }} /></AppActionsContext.Provider>)
    const section = await screen.findByRole('region', { name: 'Set up this computer' })
    await waitFor(() => expect(section.querySelector('[data-remote-step="node"]')).toHaveAttribute('data-mark', 'running'))
    const row = section.querySelector('[data-remote-step="node"]') as HTMLElement
    expect(row).toHaveTextContent('██ 45%')
    fireEvent.click(within(row).getByRole('button', { name: 'Show output' }))
    expect(openRemote).toHaveBeenCalledWith(ID, 'sh-3', 'Node.js on Win PC1')
  })

  it('shows Claude Code’s warning before accepting it there', async () => {
    const posted: string[] = []
    answer((method, path) => {
      if (path === '/v1/setup') return pc
      if (path === '/v1/setup/runs') return { runs: [] }
      if (path === '/v1/claude/bypass-consent' && method === 'POST') { posted.push(path); return { accepted: true } }
      return undefined
    })
    render(<RemoteSetup m={{ id: ID, name: 'Win PC1' }} />)
    const section = await screen.findByRole('region', { name: 'Set up this computer' })
    const row = section.querySelector('[data-remote-step="bypass"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Read and accept' }))
    expect(within(row).getByRole('note', { name: 'Bypass consent' })).toHaveTextContent('First bypass session on Win PC1')
    expect(posted).toEqual([])
    fireEvent.click(within(row).getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(posted).toEqual(['/v1/claude/bypass-consent']))
  })

  it('marks a step of its own screen done here', async () => {
    const patched: unknown[] = []
    answer((method, path, body) => {
      if (path === '/v1/setup') return pc
      if (path === '/v1/setup/runs') return { runs: [] }
      if (method === 'PATCH' && path.startsWith('/v1/machines/')) { patched.push(body); return { id: ID, name: 'Win PC1' } }
      return undefined
    })
    render(<RemoteSetup m={{ id: ID, name: 'Win PC1', setup_done: ['site_sign_ins'] }} />)
    const section = await screen.findByRole('region', { name: 'Set up this computer' })
    expect(section).toHaveTextContent("Needs Win PC1's own screen")
    const row = section.querySelector('[data-remote-step="chrome_extension"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Done there' }))
    await waitFor(() => expect(patched).toEqual([{ setup_done: ['site_sign_ins', 'chrome_extension'] }]))
  })

  it('folds to one line when all is done, and says nothing for an older Caprock', async () => {
    answer((_m, path) => (path === '/v1/setup' ? allDone : path === '/v1/setup/runs' ? { runs: [] } : undefined))
    const { unmount } = render(<RemoteSetup m={{ id: ID, name: 'Win PC1', setup_done: ['chrome_extension', 'site_sign_ins'] }} />)
    const line = await screen.findByRole('button', { name: /Set up · all done/ })
    expect(screen.queryByRole('region', { name: 'Set up this computer' })).toBeNull()
    fireEvent.click(line)
    expect(screen.getByRole('region', { name: 'Set up this computer' })).toHaveTextContent('9 of 9 done')
    unmount()
    vi.restoreAllMocks()
    answer(() => undefined)
    const { container } = render(<RemoteSetup m={{ id: ID, name: 'Win PC1' }} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container).toBeEmptyDOMElement()
  })
})
