/**
 * The phone home: Continue and Saved from the daemon, a chat started from the
 * docked field in the chosen project with the words as its first message, and
 * Save landing in the Inbox.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type CatalogEntry, type InboxItem, type LimitsAnswer, type SessionSummary } from '@/lib/api'
import { FOLDS_KEY } from '@/lib/phonehome'
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
  vi.spyOn(api, 'limits').mockResolvedValue(limits)
}

let limits: LimitsAnswer = {}

let chats: SessionSummary[] = []

beforeEach(() => {
  vi.restoreAllMocks()
  chats = []
  limits = {}
  localStorage.clear()
  location.hash = '#/'
})

const openChats = () => fireEvent.click(screen.getByRole('button', { name: /^Chats/ }))

describe('PhoneHome', () => {
  // Owner, 2026-10-19 (translated): the phone Home as it was in 0.134.0, no
  // projects list, and no chat field at the bottom until voice works in any language.
  it('keeps projects off the phone home and the chat field folded inside Chats', async () => {
    stubs()
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    expect(screen.queryByRole('region', { name: 'Projects' })).toBeNull()
    const toggle = screen.getByRole('button', { name: /^Chats/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText('Message or note')).toBeNull()
    openChats()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('Message or note').closest('section')?.getAttribute('aria-label')).toBe('Chats')
  })

  it('New chat unfolds Chats and focuses the field', async () => {
    stubs()
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    expect(screen.getByRole('button', { name: /^Chats/ }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(screen.getByRole('button', { name: /^Chats/ }).getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(screen.getByLabelText('Message or note'))
  })

  it('preserves a session route when the kept home mounts after a tablet becomes narrow', async () => {
    stubs()
    window.history.replaceState(null, '', '/#/session/s1?tab=chat')
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    expect(window.location.hash).toBe('#/session/s1?tab=chat')
  })

  it('lists the sessions to continue and what was saved', async () => {
    stubs([{ id: 7, text: 'an idea for later', files: [], created_at: NOW - 1000 }])
    render(<PhoneHome />)
    expect(await screen.findByText('work in alpha')).toBeTruthy()
    expect(screen.getByText('work in beta')).toBeTruthy()
    // Saved is folded by default: one line, then the rows once unfolded.
    fireEvent.click(await screen.findByRole('button', { name: 'Saved' }))
    expect(await screen.findByText('an idea for later')).toBeTruthy()
    expect(screen.getByText('Full dashboard').closest('a')?.getAttribute('href')).toBe('#/home')
  })

  it('starts a chat in the chosen project with the typed words as its first message', async () => {
    stubs()
    const spawn = vi.spyOn(api, 'spawn').mockResolvedValue({ session_id: 'new1', cwd: '/home/me/beta' })
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    openChats()
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
    openChats()
    fireEvent.click(screen.getAllByText('New chat').at(-1)!)
    await waitFor(() => expect(spawn).toHaveBeenCalled())
    expect(spawn.mock.calls[0]![0]).toEqual({ chat: true, model: 'claude-sonnet-5-5' })
    await waitFor(() => expect(location.hash).toBe('#/chats/c1'))
  })

  it('starts a plain chat on the typed words when no project is picked', async () => {
    stubs()
    const spawn = vi.spyOn(api, 'spawn').mockResolvedValue({ session_id: 'c2', cwd: '/data/chats/2026-10-16-101011' })
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    openChats()
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
    openChats()
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
    await screen.findByText('Chats · 1')
    openChats()
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
    openChats()
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

// Owner, 2026-10-21: the recommended set — New chat filled, Continue,
// Releases and Saved fold, one Limits line, context and subagents on rows.
describe('PhoneHome folds, limits and rows', () => {
  afterEach(() => { vi.useRealTimers() })
  const header = (name: string) => screen.getByRole('button', { name })

  it('opens with Continue open, Saved folded to one line, and the Waiting card never folds', async () => {
    stubs([{ id: 7, text: 'an idea for later', files: [], created_at: NOW - 2 * 3600_000 }])
    vi.mocked(api.sessionsWithTotal).mockResolvedValue({ items: [
      session('s1', 'alpha', 'working'), session('s2', 'beta', 'idle'), session('s3', 'gamma', 'waiting-on-you', { owned: false }),
    ], total: 3 })
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    expect(header('Continue').getAttribute('aria-expanded')).toBe('true')
    const saved = await screen.findByRole('region', { name: 'Saved' })
    expect(header('Saved').getAttribute('aria-expanded')).toBe('false')
    expect(saved.querySelector('[data-fold-summary]')?.textContent).toBe('1 · newest 2h ago: “an idea for later”')
    expect(saved.querySelector('ul')).toBeNull()
    // Folding Continue leaves the counts.
    fireEvent.click(header('Continue'))
    expect(screen.queryByText('work in alpha')).toBeNull()
    expect(screen.getByRole('region', { name: 'Continue' }).querySelector('[data-fold-summary]')?.textContent).toBe('1 need you · 1 working · 1 idle')
    expect(JSON.parse(localStorage.getItem(FOLDS_KEY)!)).toEqual({ continue: true, releases: true, saved: true })
  })

  it('keeps the folds on this device and falls back to the defaults on a broken entry', async () => {
    localStorage.setItem(FOLDS_KEY, JSON.stringify({ continue: true, saved: false }))
    stubs([{ id: 7, text: 'an idea for later', files: [], created_at: NOW - 1000 }])
    const { unmount } = render(<PhoneHome />)
    await screen.findByText('an idea for later')
    expect(screen.queryByText('work in alpha')).toBeNull()
    unmount()
    localStorage.setItem(FOLDS_KEY, '{not json')
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    expect(header('Saved').getAttribute('aria-expanded')).toBe('false')
  })

  it('New chat is the filled pill in the Chats row', async () => {
    stubs()
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    const pill = screen.getByRole('button', { name: 'New chat' })
    expect(pill.className).toContain('bg-accent')
    expect(pill.closest('section')?.getAttribute('aria-label')).toBe('Chats')
  })

  it('draws the Limits line: 5-hour with its reset, the week, amber from 80%, red from 95%, a tap to Cost limits', async () => {
    const at = Math.floor(NOW / 1000)
    limits = { rate_limits: { five_hour: { used_percentage: 82, resets_at: at + 80 * 60 }, seven_day: { used_percentage: 96, resets_at: at + 3 * 86400 } } }
    stubs()
    render(<PhoneHome />)
    const line = await waitFor(() => { const el = document.querySelector<HTMLAnchorElement>('[data-phone-limits]'); expect(el).toBeTruthy(); return el! })
    expect(line.getAttribute('href')).toBe('#/cost?section=limits')
    expect(line.querySelector('[data-limit-main]')?.textContent).toBe('5h 82%')
    expect(line.querySelector('[data-limit-main]')?.className).toContain('text-warn')
    expect(line.textContent).toContain('↻ 1h 20m')
    expect(line.querySelector('[data-limit-week]')?.textContent).toBe('week 96%')
    expect(line.querySelector('[data-limit-week]')?.className).toContain('text-danger')
  })

  it("shows Codex's windows when Claude Code has none", async () => {
    limits = { codex_rate_limits: { five_hour: { used_percentage: 12, resets_at: Math.floor(NOW / 1000) + 3600 } } }
    stubs()
    render(<PhoneHome />)
    const line = await waitFor(() => { const el = document.querySelector('[data-phone-limits]'); expect(el).toBeTruthy(); return el! })
    expect(line.textContent).toContain('Codex')
    expect(line.querySelector('[data-limit-main]')?.className).not.toMatch(/text-(warn|danger)/)
  })

  it('draws no Limits line when no window is known', async () => {
    stubs()
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    await waitFor(() => expect(api.limits).toHaveBeenCalled())
    expect(document.querySelector('[data-phone-limits]')).toBeNull()
  })

  it('reads the limits on opening only, never on a timer', async () => {
    stubs()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    expect(api.limits).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(10 * 60_000) })
    expect(api.limits).toHaveBeenCalledTimes(1)
  })

  it('says the context and the subagents on a live Continue row, amber from 80%', async () => {
    stubs()
    vi.mocked(api.sessionsWithTotal).mockResolvedValue({ items: [
      session('s1', 'alpha', 'working', { context: { tokens: 1, window: 1, pct: 84.2, next_call_usd: 0 }, live_subagents: 3 }),
      session('s2', 'beta', 'idle', { context: { tokens: 1, window: 1, pct: 38, next_call_usd: 0 } }),
      session('s3', 'gamma', 'idle', { status: 'ended', context: { tokens: 1, window: 1, pct: 90, next_call_usd: 0 } }),
    ], total: 3 })
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    const metas = [...document.querySelectorAll('[data-row-meta]')]
    expect(metas.map((m) => m.textContent)).toEqual(['context 84%· 3 subagents', 'context 38%'])
    expect(metas[0]!.querySelector('.text-warn')).toBeTruthy()
    expect(metas[1]!.querySelector('.text-warn')).toBeNull()
  })
})
