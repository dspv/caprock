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
  vi.spyOn(api, 'agentCatalog').mockResolvedValue({ agents: [claude], licensed: false } as unknown as Awaited<ReturnType<typeof api.agentCatalog>>)
  vi.spyOn(api, 'subscriptions').mockResolvedValue({ agents: [] } as unknown as Awaited<ReturnType<typeof api.subscriptions>>)
}

beforeEach(() => {
  vi.restoreAllMocks()
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
    await waitFor(() => expect((screen.getByLabelText('Project') as HTMLSelectElement).options.length).toBe(2))
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '/home/me/beta' } })
    fireEvent.change(screen.getByLabelText('Message or note'), { target: { value: 'fix the flaky test' } })
    fireEvent.click(screen.getByText('Start chat'))
    await waitFor(() => expect(spawn).toHaveBeenCalled())
    expect(spawn.mock.calls[0]![0]).toEqual({ cwd: '/home/me/beta', prompt: 'fix the flaky test' })
    await waitFor(() => expect(location.hash).toBe('#/session/new1?tab=chat'))
  })

  it('opens New chat on an empty field instead of starting one', async () => {
    stubs()
    const spawn = vi.spyOn(api, 'spawn')
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    fireEvent.click(screen.getByText('Start chat'))
    expect(await screen.findByRole('dialog', { name: 'New chat' })).toBeTruthy()
    expect(spawn).not.toHaveBeenCalled()
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
