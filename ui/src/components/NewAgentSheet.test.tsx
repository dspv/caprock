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
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => ({ version: 'v0.0.0', claude_available: true, claude_bypass_accepted: status.accepted, opencode_available: status.opencode !== undefined, opencode_version: status.opencode || undefined }),
      settings: async () => ({}),
      saveSettings: async (s: unknown) => { saved.push(s); return s },
      spawn: (req: unknown) => spawn(req),
      acceptBypass: () => acceptBypass(),
    },
  }
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
    expect(await screen.findByLabelText(/Tab moves, arrows change a choice, Control Enter starts, Escape cancels/)).toBeTruthy()
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
    const project = screen.getByLabelText<HTMLSelectElement>('Project')
    fireEvent.keyDown(project, { key: 'ArrowDown' })
    expect(project.value).toBe('2')
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

  it('cancels with Esc', async () => {
    const { onClose } = open()
    await screen.findByLabelText('Model')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('opens on the first message, and its fields come in the stated Tab order', async () => {
    open()
    await screen.findByLabelText('Model')
    expect(document.activeElement).toBe(screen.getByPlaceholderText('What should it do?'))
    const order = Array.from(document.querySelectorAll<HTMLElement>('select, textarea, input, button'))
      .filter((el) => !el.hasAttribute('disabled'))
      // A button's name without its key badge, which is aria-hidden.
      .map((el) => el.getAttribute('aria-label') || (el.closest('label')?.querySelector('span')?.firstChild?.textContent ?? el.firstChild?.textContent ?? '').trim())
    // The sheet's × comes first, in its header; the first message still has the caret.
    expect(order).toEqual(['Close', 'Project', 'Where', 'Model', 'Permissions', 'Add', 'First message', 'Cancel', 'Start'])
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
    fireEvent.change(screen.getByLabelText(/^Branch name/), { target: { value: 'feat/x' } })
    expect(screen.getByText('letters, digits, dot and dash only')).toBeTruthy()
    fireEvent.keyDown(screen.getByLabelText(/^Branch name/), { key: 'Enter', metaKey: true })
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
    expect(labels).toEqual(['This folder · main', 'Existing copy · caprock/login', 'New copy on its own branch'])
    expect(labels.join(' ')).not.toMatch(/worktree/i)
    expect(where.title).toMatch(/git worktree/)
  })

  it('explains a new copy in one line and asks for a branch name', async () => {
    open()
    fireEvent.change(await screen.findByLabelText<HTMLSelectElement>('Where'), { target: { value: '__new__' } })
    expect(screen.getByLabelText(/^Branch name/)).toBeTruthy()
    expect(screen.getByText(/A separate folder with its own branch, so this agent doesn’t collide with others\. Branch:/)).toBeTruthy()
    expect(screen.getByText(/^caprock\/agent-\d{4}-\d{4}$/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/^Branch name/), { target: { value: 'login-fix' } })
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
      expect(screen.getByLabelText(/Command Enter starts/).textContent).toContain('⌘↩ starts')
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
    fireEvent.keyDown(where, { key: 'ArrowDown' })
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
