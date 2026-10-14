/**
 * The New agent sheet from the keyboard alone (owner, 2026-10-07): arrows
 * change a select in place, ⌘↩ starts from anywhere in the sheet, Esc
 * cancels, and the keys are named in the sheet itself.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/lib/projects'

const spawn = vi.fn(async (_req: unknown) => ({ session_id: 'new-1', cwd: '/w/app' }))
const acceptBypass = vi.fn(async () => ({ accepted: true }))
const status = { accepted: undefined as boolean | undefined, opencode: undefined as string | undefined }
const saved: unknown[] = []
const catalogExtra = vi.hoisted(() => ({ agents: [] as unknown[] }))
const subsState = vi.hoisted(() => ({ value: undefined as unknown }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => ({ version: 'v0.0.0', claude_available: true, claude_bypass_accepted: status.accepted, opencode_available: status.opencode !== undefined, opencode_version: status.opencode || undefined }),
      agentCatalog: async () => ({
        licensed: false,
        home: '/h',
        agents: [
          { id: 'claude', label: 'Claude Code', installed: true, ready: true, models: [], observed: true, prompt: true },
          ...(status.opencode !== undefined ? [{ id: 'opencode', label: 'OpenCode', installed: true, ready: true, models: [], observed: true, prompt: true }] : []),
          ...catalogExtra.agents,
        ],
      }),
      settings: async () => ({}),
      saveSettings: async (s: unknown) => { saved.push(s); return s },
      spawn: (req: unknown) => spawn(req),
      subscriptions: async () => { if (!subsState.value) throw new Error('not offered'); return subsState.value },
      acceptBypass: () => acceptBypass(),
      recentDirs: async () => [],
      localRepos: async () => ({ root: '/w', home: '/h', scanned_at: 0, repos: [{ name: 'caprock-web', path: '/w/caprock-web' }] }),
    },
  }
})
const addProject = vi.fn(async (req: { path: string }) => ({ project: { id: '9', root: req.path, name: 'caprock-web', kind: 'repo' }, created: true }))
const BRANCHES = [
  { name: 'main', main: true, default: true, local: true, remote: 'origin', committed_ms: 2 },
  { name: 'feat/old', local: true, committed_ms: 1 },
]
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, add: (req: { path: string }) => addProject(req), branches: async () => BRANCHES } }
})

import { NewAgentSheet } from './NewAgentSheet'

const projects = [
  { id: '1', root: '/w/app', name: 'app', kind: 'repo' },
  { id: '2', root: '/w/site', name: 'site', kind: 'repo' },
] as Project[]

function open(onClose = vi.fn()) {
  const onStarted = vi.fn()
  render(<NewAgentSheet projects={projects} projectId="1" onClose={onClose} onStarted={onStarted} />)
  return { onClose, onStarted }
}

beforeEach(() => { spawn.mockReset().mockResolvedValue({ session_id: 'new-1', cwd: '/w/app' }); acceptBypass.mockClear(); status.accepted = undefined; status.opencode = undefined; saved.length = 0; localStorage.clear() })

/** Picks a permission mode the way a reader does, in the select. */
async function pick(mode: string) {
  fireEvent.change(await screen.findByLabelText<HTMLSelectElement>(/^Permissions/), { target: { value: mode } })
}

describe('the New agent sheet on the keyboard', () => {
  it('names its keys in the sheet', async () => {
    open()
    expect(await screen.findByLabelText('Keys: Tab moves, arrows change a choice')).toBeTruthy()
  })

  it('changes a select with the arrow keys, in place', async () => {
    open()
    const model = await screen.findByLabelText<HTMLSelectElement>('Model')
    expect(model.value).toBe('claude-opus-5-5')
    fireEvent.keyDown(model, { key: 'ArrowDown' })
    expect(model.value).toBe('claude-sonnet-5-5')
    fireEvent.keyDown(model, { key: 'ArrowUp' })
    fireEvent.keyDown(model, { key: 'ArrowUp' })
    expect(model.value).toBe('claude-fable-5-1')
    // At the top it stays.
    fireEvent.keyDown(model, { key: 'ArrowUp' })
    expect(model.value).toBe('claude-fable-5-1')
  })

  it('starts with ⌘↩ from a select and from the footer, with what was chosen', async () => {
    open()
    const model = await screen.findByLabelText<HTMLSelectElement>('Model')
    fireEvent.keyDown(model, { key: 'ArrowDown' })
    fireEvent.keyDown(model, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(spawn.mock.calls[0]![0]).toMatchObject({ cwd: '/w/app', model: 'claude-sonnet-5-5', permission_mode: 'acceptEdits' })
  })

  it('starts with ⌘↩ while a footer button has focus', async () => {
    open()
    const cancel = await screen.findByRole('button', { name: 'Cancel' })
    cancel.focus()
    fireEvent.keyDown(cancel, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(spawn).toHaveBeenCalledOnce())
  })

  it('cancels with Esc: the first closes the project list it opens on, the second the sheet', async () => {
    const { onClose } = open()
    await screen.findByLabelText('Model')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('opens on the project search, and its fields come in the stated Tab order', async () => {
    open()
    await screen.findByLabelText('Model')
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Project' }))
    const order = Array.from(document.querySelectorAll<HTMLElement>('select, textarea, input, button'))
      .filter((el) => !el.hasAttribute('disabled'))
      // A button's name without its key badge, which is aria-hidden.
      .map((el) => el.getAttribute('aria-label') || (el.closest('label')?.querySelector('span')?.firstChild?.textContent ?? el.firstChild?.textContent ?? '').trim())
    // The sheet's × comes first, in its header; the project search has the caret.
    expect(order).toEqual(['Close', 'Project', 'Where', 'Model', 'Permissions', 'Add project instructions', 'First message', 'Cancel', 'Start'])
  })
})

/** ADR-041: the first bypass session on a machine shows Claude Code's warning
 *  here, where "Accept and start" is the explicit answer. */
describe('the one-time bypass consent', () => {
  it('shows the warning and asks for it in the button, and records it before starting', async () => {
    status.accepted = false
    open()
    await pick('bypassPermissions')
    expect(await screen.findByRole('note', { name: 'Bypass consent' })).toBeTruthy()
    const start = screen.getByRole('button', { name: 'Accept and start' })
    fireEvent.click(start)
    await waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(acceptBypass).toHaveBeenCalledOnce()
    expect(acceptBypass.mock.invocationCallOrder[0]!).toBeLessThan(spawn.mock.invocationCallOrder[0]!)
  })

  it('is not asked for a mode that asks, nor once accepted', async () => {
    status.accepted = true
    open()
    await screen.findByRole('button', { name: 'Start' })
    expect(screen.queryByRole('note', { name: 'Bypass consent' })).toBeNull()
  })

  it('goes away when the mode is not bypass', async () => {
    status.accepted = false
    open()
    await pick('bypassPermissions')
    await screen.findByRole('note', { name: 'Bypass consent' })
    await pick('acceptEdits')
    expect(screen.queryByRole('note', { name: 'Bypass consent' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy()
  })

  it('turns the daemon’s refusal into the warning, not an error line', async () => {
    const { ApiError } = await import('@/lib/api')
    spawn.mockRejectedValueOnce(new ApiError(409, 'Conflict', { error: 'Bypass needs a one-time consent first', code: 'bypass_consent' }))
    open()
    await pick('bypassPermissions')
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    expect(await screen.findByRole('note', { name: 'Bypass consent' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Accept and start' })).toBeTruthy()
  })
})

/** ADR-043 (owner, 2026-10-08): a new install asks before running commands;
 *  bypass is one pick away, and a picked mode is kept for the next agent. */
describe('the permission mode a new agent starts in', () => {
  it('asks first on a fresh install, and keeps nothing it was not told', async () => {
    open()
    expect((await screen.findByLabelText<HTMLSelectElement>(/^Permissions/)).value).toBe('acceptEdits')
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(saved).toEqual([])
  })

  it('keeps a picked mode for the next agent, once the session has started', async () => {
    status.accepted = true
    open()
    await pick('bypassPermissions')
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(saved).toEqual([{ spawn_permission_mode: 'bypassPermissions' }]))
    expect(spawn.mock.calls[0]![0]).toMatchObject({ permission_mode: 'bypassPermissions' })
  })

  it('keeps nothing when the start fails', async () => {
    status.accepted = true
    spawn.mockRejectedValueOnce(new Error('no claude'))
    open()
    await pick('plan')
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('alert')
    expect(saved).toEqual([])
  })
})

describe('a new worktree from the sheet', () => {
  it('names it from the first message when the name is left empty', async () => {
    open()
    fireEvent.change(await screen.findByLabelText<HTMLSelectElement>('Where'), { target: { value: '__new__' } })
    fireEvent.change(screen.getByPlaceholderText('What should it do?'), { target: { value: 'Fix the login bug' } })
    expect(screen.getByText('caprock/fix-the-login-bug')).toBeTruthy()
    fireEvent.keyDown(screen.getByPlaceholderText('What should it do?'), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(spawn.mock.calls[0]![0]).toMatchObject({ worktree: 'fix-the-login-bug' })
  })

  it('says beside the field what a typed name may not contain, and does not start', async () => {
    open()
    fireEvent.change(await screen.findByLabelText<HTMLSelectElement>('Where'), { target: { value: '__new__' } })
    fireEvent.change(screen.getByLabelText(/^New branch name/), { target: { value: 'feat/x' } })
    expect(screen.getByText('letters, digits, dot and dash only')).toBeTruthy()
    fireEvent.keyDown(screen.getByLabelText(/^New branch name/), { key: 'Enter', metaKey: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(spawn).not.toHaveBeenCalled()
  })
})

/** Owner, 2026-10-09: "I didn't understand what worktree this is — existing
 *  or new". Where says it in words that need no git. */
describe('Where, in plain words', () => {
  const withCopy = [
    { ...projects[0]!, branch: 'main', worktrees: [{ path: '/w/app/.caprock-worktrees/login', name: 'login', branch: 'caprock/login' }] },
    projects[1]!,
  ] as Project[]

  it('names this folder, an existing copy and a new copy, never "worktree"', async () => {
    render(<NewAgentSheet projects={withCopy} projectId="1" onClose={vi.fn()} onStarted={vi.fn()} />)
    const where = await screen.findByLabelText<HTMLSelectElement>('Where')
    const labels = Array.from(where.options).map((o) => o.textContent)
    expect(labels).toEqual(['New copy from a branch', 'This folder · main', 'Existing copy · caprock/login'])
    expect(labels.join(' ')).not.toMatch(/worktree/i)
    expect(where.title).toMatch(/git worktree/)
  })

  it('explains a new copy in one line and asks for a branch name', async () => {
    open()
    fireEvent.change(await screen.findByLabelText<HTMLSelectElement>('Where'), { target: { value: '__new__' } })
    expect(screen.getByLabelText(/^New branch name/)).toBeTruthy()
    expect(screen.getByText(/A separate folder, so this agent doesn’t collide with others:/)).toBeTruthy()
    expect(screen.getByText(/^caprock\/agent-\d{4}-\d{4}$/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/^New branch name/), { target: { value: 'login-fix' } })
    expect(screen.getByText('caprock/login-fix')).toBeTruthy()
    expect(screen.queryByText(/worktree/i)).toBeNull()
  })
})

/** Owner, 2026-10-09: "the button is there but the shortcut is unclear". */
describe('the start key on the Start button', () => {
  it('shows ⌘↩ on Start on a Mac, and Start keeps its name', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    try {
      open()
      const start = await screen.findByRole('button', { name: 'Start' })
      expect(start.querySelector('kbd')?.textContent).toBe('⌘↩')
      expect(start.getAttribute('aria-keyshortcuts')).toBe('Meta+Enter')
      expect(screen.getByRole('button', { name: 'Cancel' }).querySelector('kbd')?.textContent).toBe('Esc')
    } finally {
      platform.mockRestore()
    }
  })

  it('shows Ctrl+↵ off macOS, and Ctrl+Enter starts', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    try {
      open()
      const start = await screen.findByRole('button', { name: 'Start' })
      expect(start.querySelector('kbd')?.textContent).toBe('Ctrl+↵')
      expect(start.getAttribute('aria-keyshortcuts')).toBe('Control+Enter')
      fireEvent.keyDown(screen.getByLabelText('Project'), { key: 'Enter', ctrlKey: true })
      await waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    } finally {
      platform.mockRestore()
    }
  })

  it('starts with ⌘↩ from every field: each select and the first message', async () => {
    for (const field of ['Project', 'Where', 'Model', 'Permissions', 'First message']) {
      spawn.mockClear()
      const { unmount } = render(<NewAgentSheet projects={projects} projectId="1" onClose={vi.fn()} onStarted={vi.fn()} />)
      const el = field === 'First message' ? await screen.findByPlaceholderText('What should it do?') : await screen.findByLabelText(field === 'Permissions' ? /^Permissions/ : field)
      el.focus()
      fireEvent.keyDown(el, { key: 'Enter', metaKey: true })
      await waitFor(() => expect(spawn, field).toHaveBeenCalledOnce())
      unmount()
    }
  })
})

/** Owner, 2026-10-09: "when filling the form, focus sometimes jumps between
 *  fields". The app shell re-renders on every poll and live event, with a new
 *  onClose and a new projects array each time; none of that may move focus. */
describe('focus stays where the person put it', () => {
  it('survives the parent re-rendering mid-typing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const props = () => ({ projects: projects.map((p) => ({ ...p })), projectId: '1', onClose: () => {}, onStarted: () => {} })
      const { rerender } = render(<NewAgentSheet {...props()} />)
      const message = await screen.findByPlaceholderText<HTMLTextAreaElement>('What should it do?')
      message.focus()
      expect(document.activeElement).toBe(message)
      fireEvent.change(message, { target: { value: 'Fix the' } })
      // A poll tick: same data, new identities, as AppShell passes them.
      for (let i = 0; i < 5; i++) {
        rerender(<NewAgentSheet {...props()} />)
        await vi.advanceTimersByTimeAsync(1000)
      }
      expect(document.activeElement).toBe(message)
      // And where the person moved it, it stays too.
      const model = screen.getByLabelText<HTMLSelectElement>('Model')
      model.focus()
      rerender(<NewAgentSheet {...props()} />)
      await vi.advanceTimersByTimeAsync(1000)
      expect(document.activeElement).toBe(model)
      expect(message.value).toBe('Fix the')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays put when a new copy is chosen and its field appears', async () => {
    open()
    const where = await screen.findByLabelText<HTMLSelectElement>('Where')
    where.focus()
    fireEvent.keyDown(where, { key: 'ArrowUp' })
    expect(where.value).toBe('__new__')
    expect(document.activeElement).toBe(where)
  })
})

describe('the New agent sheet with OpenCode', () => {
  const labels = async () => Array.from((await screen.findByLabelText<HTMLSelectElement>(/^Permissions/)).options).map((o) => o.textContent)
  const pickOpenCode = async () => {
    fireEvent.change(await screen.findByLabelText<HTMLSelectElement>(/^Agent/), { target: { value: 'opencode' } })
  }

  it('words bypass as OpenCode 1 does when 1 is installed', async () => {
    status.opencode = '1.15.10'
    open()
    await pickOpenCode()
    await waitFor(async () => expect(await labels()).toContain("Bypass · OpenCode's own rules"))
  })

  it('words bypass as --auto when OpenCode 2 is installed', async () => {
    status.opencode = '2.0.26'
    open()
    await pickOpenCode()
    await waitFor(async () => expect(await labels()).toContain("Bypass · approves all it doesn't deny"))
    expect(await labels()).toContain("Plan · OpenCode's plan agent")
  })
})

/** The Project field is a search (owner, 2026-10-10: a native select had none). */
describe('the project search', () => {
  it('keeps the current project on Enter, and a second Enter starts', async () => {
    open()
    const search = await screen.findByRole('combobox', { name: 'Project' })
    expect(document.activeElement).toBe(search)
    await screen.findByRole('option', { name: /app/ })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(spawn.mock.calls[0]![0]).toMatchObject({ cwd: '/w/app' })
  })

  it('finds another project by a few letters, and Esc closes the list before the sheet', async () => {
    const { onClose } = open()
    const search = await screen.findByRole('combobox', { name: 'Project' })
    fireEvent.change(search, { target: { value: 'si' } })
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('site')
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.change(search, { target: { value: 'si' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect((search as HTMLInputElement).value).toBe('site')
    fireEvent.keyDown(search, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(spawn.mock.calls[0]![0]).toMatchObject({ cwd: '/w/site' })
  })

  it('adds a repository under the default folder when it is picked, and starts there', async () => {
    addProject.mockClear()
    open()
    const search = await screen.findByRole('combobox', { name: 'Project' })
    fireEvent.change(search, { target: { value: 'cpw' } })
    const row = await screen.findByRole('option', { name: /caprock-web/ })
    expect(row.textContent).toContain('repo · add')
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(addProject).toHaveBeenCalledWith({ path: '/w/caprock-web' }))
    await waitFor(() => expect((search as HTMLInputElement).value).toBe('caprock-web'))
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(spawn.mock.calls[0]![0]).toMatchObject({ cwd: '/w/caprock-web' })
  })
})

/** ADR-046: an agent that is not installed is listed, never the default, and
 *  picking it shows how to install it instead of a model list. */
describe('an agent that is not installed', () => {
  it('is listed after the rest, and picking it offers the install in a shell tab', async () => {
    catalogExtra.agents = [{ id: 'grok', label: 'Grok', installed: false, ready: false, models: [], observed: false, prompt: true, setup: { reason: 'not_installed', text: 'Grok is not installed on this machine.', command: 'curl -fsSL https://x.ai/cli/install.sh | bash', docs: 'https://docs.x.ai/build/overview' } }]
    try {
      const onSetup = vi.fn()
      const onClose = vi.fn()
      render(<NewAgentSheet projects={projects} projectId="1" onClose={onClose} onSetup={onSetup} onStarted={() => {}} />)
      const picker = await screen.findByLabelText<HTMLSelectElement>('Agent')
      expect(picker.value).toBe('claude')
      expect(Array.from(picker.options).map((o) => o.textContent)).toEqual(['Claude Code', 'Grok · not installed'])
      fireEvent.change(picker, { target: { value: 'grok' } })
      expect(screen.getByText('Grok is not installed on this machine.')).toBeInTheDocument()
      expect(screen.queryByLabelText('Model')).toBeNull()
      expect(screen.getByRole('button', { name: /^Start/ })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Install in a shell tab' }))
      expect(onSetup).toHaveBeenCalledWith('curl -fsSL https://x.ai/cli/install.sh | bash', '/h')
      expect(onClose).toHaveBeenCalled()
    } finally {
      catalogExtra.agents = []
    }
  })
})

/** Owner, 2026-10-10: "I want to take it from master/main, pulled from the chosen branch". */
describe('a new copy from a branch', () => {
  it('starts from the default branch, pulled first, and remembers the choice', async () => {
    open()
    fireEvent.change(await screen.findByLabelText<HTMLSelectElement>('Where'), { target: { value: '__new__' } })
    expect(await screen.findByLabelText('Start from branch')).toHaveAttribute('placeholder', 'main')
    expect(screen.getByRole('checkbox')).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }))
    await waitFor(() => expect(spawn).toHaveBeenCalled())
    expect(spawn.mock.calls[0]![0]).toMatchObject({ worktree_base: 'main', worktree_pull: true })
    expect(localStorage.getItem('caprock.newAgent.where')).toBe('__new__')
  })
})

/** ADR-048: the sign-in a session runs on, picked beside the agent. */
describe('the subscription picker', () => {
  const sub = (id: string, label: string, used: number) => ({
    id, agent: 'claude', label, default: id === 'default', dir: `/d/${id}`, signed_in: true, login_command: 'claude auth login',
    windows: [{ window: 'five_hour', used_percentage: used, resets_at: Math.floor(Date.now() / 1000) + 3600, observed_at: 0 }],
    sessions_7d: 0, cost_7d_usd: 0, running: 0,
  })
  const withSubs = () => {
    subsState.value = { licensed: false, free_per_agent: 3, agents: [{ agent: 'claude', label: 'Claude Code', installed: true, subscriptions: [sub('default', 'Default', 95), sub('ab12', 'Personal', 10)] }] }
  }

  it('is not there with one sign-in', async () => {
    subsState.value = undefined
    open()
    await screen.findByRole('button', { name: /^Start/ })
    expect(screen.queryByLabelText('Subscription')).toBeNull()
  })

  it('says the chosen one is near its window and switches this session only', async () => {
    withSubs()
    try {
      open()
      expect(await screen.findByText(/Default: 95% of its 5-hour window used/)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Personal' }))
      expect(screen.getByLabelText<HTMLSelectElement>('Subscription').value).toBe('ab12')
      // Picked for this session only: nothing remembered.
      expect(localStorage.getItem('caprock.subscription.claude.1')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /^Start/ }))
      await waitFor(() => expect(spawn).toHaveBeenCalled())
      expect(spawn.mock.calls[0]![0]).toMatchObject({ subscription: 'ab12' })
    } finally {
      subsState.value = undefined
    }
  })

  // A tester, 2026-10-12: "I can't change the default account."
  it('starts on the one made the default, and names the own sign-in when picked', async () => {
    subsState.value = { licensed: false, free_per_agent: 3, agents: [{ agent: 'claude', label: 'Claude Code', installed: true, subscriptions: [sub('default', 'Own sign-in', 10), { ...sub('ab12', 'Work', 10), preferred: true }] }] }
    try {
      open()
      const select = await screen.findByLabelText<HTMLSelectElement>('Subscription')
      expect(select.value).toBe('ab12')
      expect(screen.getByRole('option', { name: /Work \(default\)/ })).toBeInTheDocument()
      fireEvent.change(select, { target: { value: 'default' } })
      expect(localStorage.getItem('caprock.subscription.claude.1')).toBe('default')
      fireEvent.click(screen.getByRole('button', { name: /^Start/ }))
      await waitFor(() => expect(spawn).toHaveBeenCalled())
      expect(spawn.mock.calls[0]![0]).toMatchObject({ subscription: 'default' })
    } finally {
      subsState.value = undefined
      localStorage.removeItem('caprock.subscription.claude.1')
    }
  })

  it('remembers a pick in the select for the project', async () => {
    withSubs()
    try {
      open()
      fireEvent.change(await screen.findByLabelText<HTMLSelectElement>('Subscription'), { target: { value: 'ab12' } })
      expect(localStorage.getItem('caprock.subscription.claude.1')).toBe('ab12')
    } finally {
      subsState.value = undefined
    }
  })
})

/** One prompt, N attempts (ADR-052): several copies of one branch, one agent each. */
describe('attempts', () => {
  it('starts N copies on one message and hands every session back', async () => {
    spawn.mockResolvedValue({ session_id: 'a-1', cwd: '/w/app/.caprock-worktrees/fix-1', session_ids: ['a-1', 'a-2', 'a-3'], attempt_group: 'g1' } as never)
    const onAttempts = vi.fn()
    const onStarted = vi.fn()
    render(<NewAgentSheet projects={projects} projectId="1" onClose={vi.fn()} onStarted={onStarted} onAttempts={onAttempts} />)
    fireEvent.change(await screen.findByLabelText<HTMLSelectElement>('Where'), { target: { value: '' } })
    // Only a new copy offers attempts.
    expect(screen.queryByLabelText(/^Attempts/)).toBeNull()
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>('Where'), { target: { value: '__new__' } })
    const attempts = screen.getByLabelText<HTMLSelectElement>(/^Attempts/)
    expect(attempts.value).toBe('1')
    fireEvent.change(attempts, { target: { value: '3' } })
    // A message is what each one works on: without one nothing starts.
    fireEvent.click(screen.getByRole('button', { name: /^Start 3/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Attempts need a first message')
    expect(spawn).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText('What should it do?'), { target: { value: 'Fix the login bug' } })
    expect(screen.getByText('caprock/fix-the-login-bug-1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Start 3/ }))
    await waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(spawn.mock.calls[0]![0]).toMatchObject({ worktree: 'fix-the-login-bug', attempts: 3, prompt: 'Fix the login bug' })
    expect(onAttempts).toHaveBeenCalledWith(['a-1', 'a-2', 'a-3'], '1', 'Fix the login bug', undefined)
    expect(onStarted).not.toHaveBeenCalled()
  })

  it('sends no attempts for a folder that is not a new copy', async () => {
    open()
    fireEvent.change(await screen.findByLabelText<HTMLSelectElement>('Where'), { target: { value: '__new__' } })
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>(/^Attempts/), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>('Where'), { target: { value: '' } })
    fireEvent.change(screen.getByPlaceholderText('What should it do?'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }))
    await waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(spawn.mock.calls[0]![0]).not.toHaveProperty('attempts')
  })
})

describe('where it starts and what it is told', () => {
  it('names a multi-repo project’s repositories under Project, and shows the instructions state', async () => {
    const multi = [{ id: '3', root: '/w', name: 'work', kind: 'folder', defaults: { system_prompt: 'a\nb' }, instruction_files: ['api/CLAUDE.md'],
      repos: [{ path: '/w/api', name: 'api' }, { path: '/w/web', name: 'web' }, { path: '/w/infra', name: 'infra' }] }] as unknown as Project[]
    render(<NewAgentSheet projects={multi} projectId="3" onClose={vi.fn()} onStarted={vi.fn()} />)
    expect(await screen.findByLabelText('Repositories in this project')).toHaveTextContent('3 repos: api, web, infra')
    expect(screen.getByLabelText('Project instructions state')).toHaveTextContent('Set · 2 lines')
    expect(screen.getByLabelText('Repository instruction files')).toHaveTextContent('CLAUDE.md in api')
  })

  it('New project… hands over the first message typed so far', async () => {
    const onNewProject = vi.fn()
    render(<NewAgentSheet projects={projects} projectId="1" onClose={vi.fn()} onStarted={vi.fn()} onNewProject={onNewProject} />)
    fireEvent.change(await screen.findByPlaceholderText('What should it do?'), { target: { value: 'Read it' } })
    fireEvent.click(screen.getByRole('button', { name: 'New project…' }))
    expect(onNewProject).toHaveBeenCalledWith('Read it')
  })
})
