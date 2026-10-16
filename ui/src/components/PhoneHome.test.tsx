/**
 * The phone home: Continue and Saved from the daemon, a chat started from the
 * docked field in the chosen project with the words as its first message, and
 * Save landing in the Inbox.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type CatalogEntry, type InboxItem, type SessionSummary } from '@/lib/api'
import { projectsApi, type Project } from '@/lib/projects'
import { PhoneHome } from './PhoneHome'

const NOW = Date.now()

function session(id: string, project: string, health: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: id, project, status: 'live', owned: true, description: `work in ${project}`,
    last_event_at: NOW - 60_000, worked_at: NOW - 60_000,
    activity: { health, phrase: '', at: '' }, ...extra,
  } as unknown as SessionSummary
}

const projects: Project[] = [
  { id: '1', name: 'alpha', root: '/home/me/alpha', kind: 'repo', last_activity: NOW },
  { id: '2', name: 'beta', root: '/home/me/beta', kind: 'repo', last_activity: NOW - 1000 },
]

const claude: CatalogEntry = { id: 'claude', label: 'Claude Code', installed: true, ready: true, models: [], observed: true, prompt: true }

function stubs(inbox: InboxItem[] = []) {
  vi.spyOn(api, 'sessionsWithTotal').mockResolvedValue({ items: [session('s1', 'alpha', 'working'), session('s2', 'beta', 'idle')], total: 2 })
  vi.spyOn(projectsApi, 'list').mockResolvedValue(projects)
  vi.spyOn(api, 'inbox').mockResolvedValue({ items: inbox, max: 500 })
  vi.spyOn(api, 'work').mockResolvedValue({ now: NOW, day_start: NOW, sessions: [], hive: 'off', queued: [], repos: [], totals: { live: 0, working: 0, waiting_you: 0, today_usd: 0, machine_today_usd: 0 } })
  vi.spyOn(api, 'agentCatalog').mockResolvedValue({ agents: [claude], licensed: false } as unknown as Awaited<ReturnType<typeof api.agentCatalog>>)
  vi.spyOn(api, 'subscriptions').mockResolvedValue({ agents: [] } as unknown as Awaited<ReturnType<typeof api.subscriptions>>)
  vi.spyOn(api, 'chats').mockResolvedValue({ items: chats, total: chats.length, chats: chats.length, archived: 0 })
}

let chats: SessionSummary[] = []

beforeEach(() => {
  vi.restoreAllMocks()
  chats = []
  localStorage.clear()
  location.hash = '#/'
})

describe('PhoneHome', () => {
  it('lists the sessions to continue and what was saved', async () => {
    stubs([{ id: 7, text: 'an idea for later', files: [], created_at: NOW - 1000 }])
    render(<PhoneHome />)
    expect(await screen.findByText('work in alpha')).toBeTruthy()
    expect(screen.getByText('work in beta')).toBeTruthy()
    expect(await screen.findByText('an idea for later')).toBeTruthy()
    expect(screen.getByText('Full dashboard').closest('a')?.getAttribute('href')).toBe('#/home')
  })

  it('starts a chat in the chosen project with the typed words as its first message', async () => {
    stubs()
    const spawn = vi.spyOn(api, 'spawn').mockResolvedValue({ session_id: 'new1', cwd: '/home/me/beta' })
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    // No project, then the two projects.
    await waitFor(() => expect((screen.getByLabelText('Project') as HTMLSelectElement).options.length).toBe(3))
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '/home/me/beta' } })
    fireEvent.change(screen.getByLabelText('Message or note'), { target: { value: 'fix the flaky test' } })
    fireEvent.click(screen.getByText('Start chat'))
    await waitFor(() => expect(spawn).toHaveBeenCalled())
    expect(spawn.mock.calls[0]![0]).toMatchObject({ cwd: '/home/me/beta', prompt: 'fix the flaky test' })
    expect(spawn.mock.calls[0]![0]).not.toHaveProperty('chat')
    await waitFor(() => expect(location.hash).toBe('#/session/new1?tab=chat'))
  })

  // ADR-071: one tap, a plain chat — no project, the model used last.
  it('starts a plain chat at once on an empty field, and opens it as a chat', async () => {
    stubs()
    localStorage.setItem('caprock.quickchat', JSON.stringify({ agent: 'claude', model: 'claude-sonnet-5-5' }))
    const spawn = vi.spyOn(api, 'spawn').mockResolvedValue({ session_id: 'c1', cwd: '/data/chats/2026-10-16-101010' })
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    fireEvent.click(screen.getByText('New chat'))
    await waitFor(() => expect(spawn).toHaveBeenCalled())
    expect(spawn.mock.calls[0]![0]).toEqual({ chat: true, model: 'claude-sonnet-5-5' })
    await waitFor(() => expect(location.hash).toBe('#/chats/c1'))
  })

  it('starts a plain chat on the typed words when no project is picked', async () => {
    stubs()
    const spawn = vi.spyOn(api, 'spawn').mockResolvedValue({ session_id: 'c2', cwd: '/data/chats/2026-10-16-101011' })
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    fireEvent.change(screen.getByLabelText('Message or note'), { target: { value: 'what is a monad' } })
    fireEvent.click(screen.getByText('Start chat'))
    await waitFor(() => expect(spawn).toHaveBeenCalled())
    expect(spawn.mock.calls[0]![0]).toMatchObject({ chat: true, prompt: 'what is a monad' })
    expect(spawn.mock.calls[0]![0]).not.toHaveProperty('cwd')
  })

  it('opens Start in a project on an empty field when a project is picked', async () => {
    stubs()
    const spawn = vi.spyOn(api, 'spawn')
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    await waitFor(() => expect((screen.getByLabelText('Project') as HTMLSelectElement).options.length).toBe(3))
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '/home/me/alpha' } })
    fireEvent.click(screen.getByText('Start chat'))
    expect(await screen.findByRole('dialog', { name: 'Start in a project' })).toBeTruthy()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('lists the newest chats apart from the work, with the way to all of them', async () => {
    chats = [session('c1', 'chat · Oct 16, 10:10', 'idle', { chat: true, name: 'Monads, explained' })]
    stubs()
    vi.mocked(api.sessionsWithTotal).mockResolvedValue({ items: [session('s1', 'alpha', 'working'), { ...chats[0]!, description: 'chat words' }], total: 2 })
    render(<PhoneHome />)
    const section = await screen.findByRole('region', { name: 'Chats' })
    expect(section.textContent).toContain('Monads, explained')
    expect(screen.getByText('All chats · 1').closest('a')?.getAttribute('href')).toBe('#/chats')
    expect(screen.getByText('Monads, explained').closest('a')?.getAttribute('href')).toBe('#/chats/c1')
    // Continue is the work: the chat is not in it.
    expect(screen.getByText('work in alpha')).toBeTruthy()
    expect(screen.queryByText('chat words')).toBeNull()
  })

  it('saves what was typed to the Inbox through the Save sheet', async () => {
    stubs()
    const add = vi.spyOn(api, 'addInbox').mockResolvedValue({ item: { id: 9, text: 'remember this', files: [], created_at: NOW } })
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    fireEvent.change(screen.getByLabelText('Message or note'), { target: { value: 'remember this' } })
    fireEvent.click(screen.getByText('Save'))
    const sheet = await screen.findByRole('dialog', { name: 'Save' })
    expect((screen.getByLabelText('What to save') as HTMLTextAreaElement).value).toBe('remember this')
    fireEvent.click(sheet.querySelector('button.bg-accent')!)
    await waitFor(() => expect(add).toHaveBeenCalledWith({ text: 'remember this', project_id: 0, files: [] }))
  })

  it('opens Save filled in from another app\'s share', async () => {
    stubs()
    window.history.replaceState(null, '', '/?title=Issue&text=https%3A%2F%2Fexample.com%2F1#/')
    render(<PhoneHome />)
    await screen.findByRole('dialog', { name: 'Save' })
    expect((screen.getByLabelText('What to save') as HTMLTextAreaElement).value).toBe('Issue\nhttps://example.com/1')
    expect(window.location.search).toBe('')
  })
})
