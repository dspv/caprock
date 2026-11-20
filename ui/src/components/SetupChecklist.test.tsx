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
    vi.spyOn(api, 'agentCatalog').mockResolvedValue({ agents: [], licensed: false, home: 'C:\\Users\\me' })
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
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(addProject).toHaveBeenCalled()
    // The link item holds Turn on and Show the link.
    expect(document.querySelector('[data-setup-item="link"] [data-link-controls]')).toBeTruthy()
    expect(document.querySelector('[data-setup-ready]')).toBeNull()
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
