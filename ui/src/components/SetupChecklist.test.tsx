import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SetupChecklist, SetupChecklistCompact } from './SetupChecklist'
import { MachineReadiness, projectCount } from './MachineReadiness'
import { api } from '@/lib/api'
import { SetupShellContext } from '@/lib/setupShell'
import { AppActionsContext, nextStep, ready, shownItems, type SetupItem, type SetupReport } from '@/lib/setup'

const ID = 'f7kc4QaG4HRPYEjg19Pr-au-FeTljmKHkikFrAmRTzM'

// The owner's Windows PC on 2026-11-20: nothing but Caprock.
const fresh: SetupReport = {
  os: 'windows',
  items: [
    { key: 'git', state: 'missing', label: 'Git', detail: 'Claude Code needs it on Windows.', command: 'winget install --id Git.Git -e --source winget' },
    { key: 'agent', state: 'missing', label: 'Claude Code or Codex', detail: 'No agent is installed here yet.', command: 'irm https://claude.ai/install.ps1 | iex' },
    { key: 'signin', state: 'missing', label: 'Sign in', detail: 'Install an agent first, then sign in to your subscription.' },
    { key: 'project', state: 'missing', label: 'A project to work in', detail: 'Clone a repository or pick a folder.' },
    { key: 'link', state: 'missing', label: 'Link to your laptop', detail: 'Show this computer’s link.', command: 'caprock setup --link' },
  ],
}
// The same PC as GET /v1/setup answers since the agents became switches
// (owner, 2026-11-20): Agents with a row per agent, the link, and Projects
// here last and optional.
const switches: SetupReport = {
  os: 'windows',
  items: [
    { key: 'git', state: 'ok', label: 'Git', detail: 'Installed.' },
    { key: 'agent', state: 'missing', label: 'Agents', detail: 'Sign in to Claude Code: the browser opens, then come back here.', command: 'claude auth login' },
    { key: 'link', state: 'ok', label: 'Link to your laptop', detail: 'MacBook can start agents here.' },
    { key: 'project', state: 'not_needed', label: 'Projects here', detail: 'Optional. Clone a repository here into C:\\Users\\me\\dev, or from New agent on your laptop.', optional: true },
  ],
  agents: [
    { id: 'claude', label: 'Claude Code', on: true, state: 'missing', detail: 'Installed, not signed in.', step: 'signin', command: 'claude auth login' },
    { id: 'codex', label: 'Codex', on: false, state: 'not_needed', detail: 'Off. Switch it on to set it up here.' },
    { id: 'gemini', label: 'Gemini CLI', on: false, state: 'not_needed', detail: 'Off. Switch it on to set it up here.' },
  ],
}
const switchesReady: SetupReport = {
  ...switches,
  items: switches.items.map((i) => (i.key === 'agent' ? { ...i, state: 'ok', detail: 'Claude Code ready.', command: undefined } : i)),
  agents: [{ ...switches.agents![0]!, state: 'ok', detail: 'Signed in. Ready.', step: undefined, command: undefined }, ...switches.agents!.slice(1)],
}

const ok = (it: SetupItem, label = it.label, detail = 'Installed.'): SetupItem => ({ ...it, state: 'ok', label, detail, command: undefined })
const readyPC: SetupReport = {
  os: 'windows',
  items: [ok(fresh.items[0]!), ok(fresh.items[1]!, 'Claude Code'), ok(fresh.items[2]!, 'Signed in to Claude Code', 'Ready to work.'), ok(fresh.items[3]!, 'A project to work in', '2 projects.'), ok(fresh.items[4]!, 'Link to your laptop', 'MacBook can start agents here.')],
}

function answer(by: (url: string) => unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const body = by(String(input))
    return body === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 })
  })
}

describe('the setup checklist (ADR-099)', () => {
  beforeEach(() => {
    vi.spyOn(api, 'agentCatalog').mockResolvedValue({ agents: [], home: 'C:\\Users\\me' })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('helpers: the next step, ready, and Git hidden on Linux once installed', () => {
    expect(ready(fresh)).toBe(false)
    expect(ready(readyPC)).toBe(true)
    expect(nextStep(fresh)?.key).toBe('git')
    expect(shownItems({ ...readyPC, os: 'linux' }).map((i) => i.key)).not.toContain('git')
    expect(shownItems(readyPC).map((i) => i.key)).toContain('git')
    expect(projectCount('2 projects.')).toBe(2)
  })

  it('lists every step in order; Install types the command into a shell tab, never runs it', async () => {
    answer((u) => (u === '/v1/setup' ? fresh : undefined))
    const shell = vi.fn()
    const addProject = vi.fn()
    render(
      <SetupShellContext.Provider value={shell}>
        <AppActionsContext.Provider value={{ addProject }}>
          <SetupChecklist link={<span data-link-controls>Turn on</span>} fallback={<span>old steps</span>} />
        </AppActionsContext.Provider>
      </SetupShellContext.Provider>,
    )
    await screen.findByText('Claude Code needs it on Windows.')
    expect([...document.querySelectorAll('[data-setup-item]')].map((e) => e.getAttribute('data-setup-item'))).toEqual(['git', 'agent', 'signin', 'project', 'link'])
    const installs = screen.getAllByRole('button', { name: 'Install' })
    expect(installs).toHaveLength(2)
    fireEvent.click(installs[0]!)
    await vi.waitFor(() => expect(shell).toHaveBeenCalledWith('winget install --id Git.Git -e --source winget', 'C:\\Users\\me'))
    // An older daemon's project item: its button opens Add project too.
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    expect(addProject).toHaveBeenCalled()
    // The link item holds Turn on and Show the link.
    expect(document.querySelector('[data-setup-item="link"] [data-link-controls]')).toBeTruthy()
    expect(document.querySelector('[data-setup-ready]')).toBeNull()
  })

  // Owner, 2026-11-20: Claude Code's installer left ~/.local/bin off his PATH.
  it('an agent terminals cannot find: Add to PATH types the fix into a shell tab', async () => {
    const fix = '$d="$env:USERPROFILE\\.local\\bin"; …'
    const offPath: SetupReport = {
      ...fresh,
      items: [ok(fresh.items[0]!), { key: 'agent', state: 'missing', label: 'Claude Code is installed, but terminals can\'t find it', detail: 'Add C:\\Users\\me\\.local\\bin to your PATH so `claude` works in a terminal.', command: fix, action: 'path' }, ...fresh.items.slice(2)],
    }
    answer((u) => (u === '/v1/setup' ? offPath : undefined))
    const shell = vi.fn()
    render(
      <SetupShellContext.Provider value={shell}>
        <SetupChecklist link={null} fallback={null} />
      </SetupShellContext.Provider>,
    )
    await screen.findByText('Claude Code is installed, but terminals can\'t find it')
    fireEvent.click(screen.getByRole('button', { name: 'Add to PATH' }))
    await vi.waitFor(() => expect(shell).toHaveBeenCalledWith(fix, 'C:\\Users\\me'))
  })

  it('agents as switches: each on one says its step; a switch is kept by the daemon', async () => {
    const calls: [string, RequestInit | undefined][] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push([String(input), init])
      if (String(input) === '/v1/setup/agents/codex') {
        const on: SetupReport = { ...switches, agents: switches.agents!.map((a) => (a.id === 'codex' ? { ...a, on: true, state: 'missing', step: 'install', detail: 'Install it, then sign in.', command: 'npm install -g @openai/codex' } : a)) }
        return new Response(JSON.stringify(on), { status: 200 })
      }
      return String(input) === '/v1/setup' ? new Response(JSON.stringify(switches), { status: 200 }) : new Response('{}', { status: 404 })
    })
    const shell = vi.fn()
    render(<SetupShellContext.Provider value={shell}><SetupChecklist link={null} fallback={null} /></SetupShellContext.Provider>)
    const codex = await screen.findByRole('switch', { name: 'Codex: off' })
    expect(screen.getByRole('switch', { name: 'Claude Code: on' })).toHaveAttribute('aria-checked', 'true')
    // Off: grey and silent — no step, no button.
    expect(document.querySelector('[data-setup-agent="codex"]')!.textContent).toBe('Codex')
    // The item has no button of its own: each row has its step.
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await vi.waitFor(() => expect(shell).toHaveBeenCalledWith('claude auth login', 'C:\\Users\\me'))
    fireEvent.click(codex)
    await screen.findByRole('switch', { name: 'Codex: on' })
    const put = calls.find(([u]) => u === '/v1/setup/agents/codex')!
    expect(put[1]?.method).toBe('PUT')
    expect(put[1]?.body).toBe('{"on":true}')
    expect(document.querySelector('[data-setup-agent="codex"]')!.textContent).toContain('Install it, then sign in.')
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    await vi.waitFor(() => expect(shell).toHaveBeenCalledWith('npm install -g @openai/codex', 'C:\\Users\\me'))
  })

  it('Projects here: last, optional, a dashed circle; Ready without one; Clone opens Add project on Clone', async () => {
    answer((u) => (u === '/v1/setup' ? switchesReady : undefined))
    const cloneProject = vi.fn()
    render(<AppActionsContext.Provider value={{ addProject: vi.fn(), cloneProject }}><SetupChecklist link={null} fallback={null} /></AppActionsContext.Provider>)
    expect((await screen.findByRole('status')).textContent).toBe('Ready. Start agents from your laptop.')
    const rows = [...document.querySelectorAll('[data-setup-item]')]
    expect(rows.map((e) => e.getAttribute('data-setup-item'))).toEqual(['git', 'agent', 'link', 'project'])
    const project = rows[3]!
    expect(project.getAttribute('data-optional')).toBe('yes')
    expect(project.querySelector('[data-setup-mark="dashed"]')).toBeTruthy()
    expect(project.textContent).toContain('Optional. Clone a repository here into C:\\Users\\me\\dev')
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    expect(cloneProject).toHaveBeenCalled()
    expect(ready(switchesReady)).toBe(true)
  })

  it('Home: the project is never a step left', async () => {
    answer((u) => (u === '/v1/setup' ? switches : undefined))
    render(<SetupShellContext.Provider value={vi.fn()}><SetupChecklistCompact /></SetupShellContext.Provider>)
    expect(await screen.findByText('1 step left')).toBeTruthy()
    expect(document.querySelector('[data-setup-compact] [data-setup-item="project"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('in a browser, with no tabs, shows the command to copy and where to run it', async () => {
    answer((u) => (u === '/v1/setup' ? fresh : undefined))
    render(<SetupChecklist link={null} fallback={null} />)
    await screen.findByText('Claude Code needs it on Windows.')
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    expect(screen.getAllByText('Run this in PowerShell here, then come back:').length).toBe(2)
  })

  it('says Ready when every item is ticked', async () => {
    answer((u) => (u === '/v1/setup' ? readyPC : undefined))
    render(<SetupChecklist link={<span data-link-controls />} fallback={null} />)
    expect((await screen.findByRole('status')).textContent).toBe('Ready. Start agents from your laptop.')
    expect(document.querySelector('[data-link-controls]')).toBeNull()
  })

  it('a daemon without the route gets the steps it had', async () => {
    answer(() => undefined)
    render(<SetupChecklist link={null} fallback={<span>old steps</span>} />)
    expect(await screen.findByText('old steps')).toBeTruthy()
  })

  it('Home: only what is left, and nothing once ready', async () => {
    const f = answer((u) => (u === '/v1/setup' ? fresh : undefined))
    render(<SetupChecklistCompact />)
    expect((await screen.findByText('5 steps left'))).toBeTruthy()
    cleanup()
    f.mockImplementation(async () => new Response(JSON.stringify(readyPC), { status: 200 }))
    render(<SetupChecklistCompact />)
    await vi.waitFor(() => expect(f).toHaveBeenCalled())
    expect(document.querySelector('[data-setup-compact]')).toBeNull()
  })
})

describe('a linked computer’s readiness, on the laptop (ADR-099)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('a ready one: chips and Start an agent there, which opens New agent on it', async () => {
    answer((u) => {
      if (u === `/v1/m/${ID}/v1/setup`) return readyPC
      if (u === `/v1/m/${ID}/v1/resources`) return { sessions: [], machine: { cpus: 16, mem_total: 32 * 2 ** 30, mem_available: 1 } }
      return undefined
    })
    const newAgentOn = vi.fn()
    render(<AppActionsContext.Provider value={{ newAgentOn }}><MachineReadiness m={{ id: ID, name: 'Home PC', status: 'online' }} /></AppActionsContext.Provider>)
    fireEvent.click(await screen.findByRole('button', { name: 'Start an agent there' }))
    expect(newAgentOn).toHaveBeenCalledWith(ID)
    for (const chip of ['ready', 'online', 'Claude Code', 'signed in', '2 projects']) expect(screen.getByText(chip)).toBeTruthy()
    await screen.findByText('Windows · 32 GB')
  })

  it('chips name the agents switched on there and ready; a project is not a step', async () => {
    answer((u) => (u === `/v1/m/${ID}/v1/setup` ? { ...switchesReady, agents: [...switchesReady.agents!, { id: 'opencode', label: 'OpenCode', on: true, state: 'ok', detail: 'Signed in. Ready.' }] } : undefined))
    render(<MachineReadiness m={{ id: ID, name: 'Home PC', status: 'online' }} />)
    await screen.findByText('ready')
    for (const chip of ['Claude Code', 'OpenCode']) expect(screen.getByText(chip)).toBeTruthy()
    expect(screen.queryByText('Codex')).toBeNull()
    expect(screen.queryByText(/projects?$/)).toBeNull()
    cleanup()
    answer((u) => (u === `/v1/m/${ID}/v1/setup` ? switches : undefined))
    render(<MachineReadiness m={{ id: ID, name: 'Home PC', status: 'online' }} />)
    const next = await screen.findByText(/needs one more step/)
    expect(next.textContent).toContain('needs one more step: Claude Code is not signed in there.')
  })

  it('one with a step left says which, and where to finish it', async () => {
    answer((u) => (u === `/v1/m/${ID}/v1/setup` ? { ...readyPC, items: readyPC.items.map((i) => (i.key === 'agent' ? fresh.items[1]! : i)) } : undefined))
    render(<MachineReadiness m={{ id: ID, name: 'Office Mac', status: 'online' }} />)
    const next = await screen.findByText(/needs one more step/)
    expect(next.closest('[data-machine-next]')!.textContent).toBe('Office Mac needs one more step: no agent is installed there yet. Open Caprock on it and finish its checklist, or run caprock setup there over SSH.')
  })

  it('an older Caprock there (404) shows nothing new', async () => {
    const f = answer(() => undefined)
    const { container } = render(<MachineReadiness m={{ id: ID, name: 'Old', status: 'online' }} />)
    await vi.waitFor(() => expect(f).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})
