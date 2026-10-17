/**
 * Ending from a phone's lists (owner, 2026-10-16, translated: "From the phone
 * I can't end a session — e.g. I have some trial chats and I can't end them
 * if I want"): each live row Caprock started has End in its ⋯ (and on a swipe
 * left), one confirm, then the polite `end`; the row turns ended and a chat
 * stays listed. Where End is not allowed the row says why — and nothing here
 * ever signals a session Caprock did not start (rule 7).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type CatalogEntry, type SessionSummary } from '@/lib/api'
import { projectsApi } from '@/lib/projects'
import { ChatsScreen } from '@/screens/Chats'
import { ChatScreen } from '@/screens/Chat'
import { PhoneHome } from './PhoneHome'
import { endState, WHY_DETACHED, WHY_NOT_OURS, WHY_WATCH } from './PhoneEnd'

const control = vi.hoisted(() => ({ value: true }))
vi.mock('@/lib/useCanControl', () => ({ useCanControl: () => control.value }))

const NOW = Date.now()

function chat(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: id, cwd: `/data/chats/${id}`, project: 'chat', status: 'active', owned: true, chat: true,
    last_event_at: NOW - 60_000, worked_at: NOW - 60_000, agent: 'claude', model_display: 'Opus 5.5',
    description: `trial ${id}`, description_source: 'prompt',
    activity: { health: 'idle', phrase: '', at: '' }, stats: {}, ...extra,
  } as unknown as SessionSummary
}

function work(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: id, cwd: `/home/me/${id}`, project: id, status: 'active', owned: true, description: `work in ${id}`,
    last_event_at: NOW - 60_000, worked_at: NOW - 60_000,
    activity: { health: 'idle', phrase: '', at: '' }, ...extra,
  } as unknown as SessionSummary
}

const claude: CatalogEntry = { id: 'claude', label: 'Claude Code', installed: true, ready: true, models: [], observed: true, prompt: true }

beforeEach(() => {
  vi.restoreAllMocks()
  control.value = true
  localStorage.clear()
  location.hash = '#/chats'
  vi.spyOn(api, 'agentCatalog').mockResolvedValue({ agents: [claude], licensed: false } as unknown as Awaited<ReturnType<typeof api.agentCatalog>>)
})

describe('endState', () => {
  it('offers End only for a live session Caprock holds, on a device that may control it', () => {
    expect(endState({ owned: true, status: 'active' }, true)).toEqual({ can: true })
    expect(endState({ owned: true, status: 'ended' }, true)).toBeNull()
    expect(endState({ owned: false, status: 'ended' }, false)).toBeNull()
    expect(endState({ owned: true, status: 'idle', detached: true }, true)).toEqual({ can: false, why: WHY_DETACHED })
    expect(endState({ owned: true, status: 'active' }, false)).toEqual({ can: false, why: WHY_WATCH })
  })

  it('names rule 7 first for a terminal’s own session: allowing control would not change it', () => {
    expect(endState({ owned: false, status: 'active' }, true)).toEqual({ can: false, why: WHY_NOT_OURS })
    expect(endState({ owned: false, status: 'active' }, false)).toEqual({ can: false, why: WHY_NOT_OURS })
    expect(WHY_NOT_OURS).toBe('Started in your own terminal — Caprock never stops it (rule 7).')
    expect(WHY_WATCH).toContain('Settings → Use on your phone → Allow control')
  })
})

describe('the Chats list', () => {
  it('ends a live chat from its ⋯: one confirm, the polite end, then the row says ended and stays', async () => {
    vi.spyOn(api, 'chats').mockResolvedValue({ items: [chat('c1')], total: 1, chats: 1, archived: 0 })
    const signal = vi.spyOn(api, 'signal').mockResolvedValue(undefined)
    render(<ChatsScreen />)
    await screen.findByRole('list', { name: 'Chats' })
    fireEvent.click(screen.getByRole('button', { name: 'More for Trial c1' }))
    const menu = screen.getByRole('menu', { name: 'More for Trial c1' })
    // End first; Archive and Delete are still there.
    const items = within(menu).getAllByRole('menuitem').map((b) => b.textContent)
    expect(items).toEqual(['End session…', 'Rename', 'Archive', 'Delete…'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'End session…' }))
    const sheet = screen.getByRole('alertdialog', { name: 'End the session' })
    expect(sheet).toHaveTextContent('End Trial c1?')
    expect(signal).not.toHaveBeenCalled()
    fireEvent.click(within(sheet).getByRole('button', { name: 'End session' }))
    await waitFor(() => expect(signal).toHaveBeenCalledWith('c1', 'end'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    const row = screen.getByRole('link', { name: /Trial c1/ })
    expect(row).toHaveTextContent('ended')
    // Ended: nothing to end, the chat is still in the list to continue.
    fireEvent.click(screen.getByRole('button', { name: 'More for Trial c1' }))
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'End session…' })).toBeNull()
  })

  it('a swipe left on a live row opens the same confirm', async () => {
    vi.spyOn(api, 'chats').mockResolvedValue({ items: [chat('c1')], total: 1, chats: 1, archived: 0 })
    const signal = vi.spyOn(api, 'signal').mockResolvedValue(undefined)
    render(<ChatsScreen />)
    const row = (await screen.findByRole('link', { name: /Trial c1/ })).closest('li')!
    fireEvent.touchStart(row, { touches: [{ clientX: 300, clientY: 20 }] })
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 180, clientY: 26 }] })
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'End the session' })).getByRole('button', { name: 'End session' }))
    await waitFor(() => expect(signal).toHaveBeenCalledWith('c1', 'end'))
  })

  it('a chat started outside Caprock says why in one line and is never signalled (rule 7)', async () => {
    vi.spyOn(api, 'chats').mockResolvedValue({ items: [chat('c1', { owned: false })], total: 1, chats: 1, archived: 0 })
    const signal = vi.spyOn(api, 'signal').mockResolvedValue(undefined)
    render(<ChatsScreen />)
    await screen.findByRole('list', { name: 'Chats' })
    fireEvent.click(screen.getByRole('button', { name: 'More for Trial c1' }))
    const menu = screen.getByRole('menu')
    expect(menu).toHaveTextContent(WHY_NOT_OURS)
    expect(within(menu).queryByRole('menuitem', { name: 'End session…' })).toBeNull()
    // A swipe opens the reason too, never the confirm.
    const row = screen.getByRole('link', { name: /Trial c1/ }).closest('li')!
    fireEvent.click(screen.getByRole('button', { name: 'More for Trial c1' }))
    fireEvent.touchStart(row, { touches: [{ clientX: 300, clientY: 20 }] })
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 150, clientY: 20 }] })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('menu')).toHaveTextContent(WHY_NOT_OURS)
    expect(signal).not.toHaveBeenCalled()
  })

  it('on a phone that can only watch: the reason names the setting, and no Rename or Delete', async () => {
    control.value = false
    vi.spyOn(api, 'chats').mockResolvedValue({ items: [chat('c1')], total: 1, chats: 1, archived: 0 })
    render(<ChatsScreen />)
    await screen.findByRole('list', { name: 'Chats' })
    fireEvent.click(screen.getByRole('button', { name: 'More for Trial c1' }))
    const menu = screen.getByRole('menu')
    expect(menu).toHaveTextContent(WHY_WATCH)
    expect(within(menu).queryAllByRole('menuitem')).toEqual([])
  })

  it('an ended chat on a watching phone has no ⋯ at all: nothing to end, nothing to do', async () => {
    control.value = false
    vi.spyOn(api, 'chats').mockResolvedValue({ items: [chat('c1', { status: 'ended' })], total: 1, chats: 1, archived: 0 })
    render(<ChatsScreen />)
    await screen.findByRole('list', { name: 'Chats' })
    expect(screen.queryByRole('button', { name: 'More for Trial c1' })).toBeNull()
  })
})

describe('one chat', () => {
  it('ends from the ⋯ sheet, End first, and the bar then says ended', async () => {
    const live = { ...chat('c1'), files: [], events: [] }
    const session = vi.spyOn(api, 'session').mockResolvedValue(live as never)
    vi.spyOn(api, 'chatFiles').mockResolvedValue({ files: [] })
    const signal = vi.spyOn(api, 'signal').mockResolvedValue(undefined)
    vi.spyOn(api, 'recentEvents').mockResolvedValue([])
    render(<ChatScreen id="c1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('button', { name: 'End this chat…' }))
    session.mockResolvedValue({ ...live, status: 'ended', resume: { ok: true, command: '' } } as never)
    fireEvent.click(screen.getByRole('button', { name: 'End session' }))
    await waitFor(() => expect(signal).toHaveBeenCalledWith('c1', 'end'))
    await waitFor(() => expect(session).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/Opus 5\.5 · ended/)).toBeTruthy()
  })

  it('a chat Caprock did not start says why in the sheet and offers no End (rule 7)', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ ...chat('c1', { owned: false }), files: [], events: [] } as never)
    vi.spyOn(api, 'chatFiles').mockResolvedValue({ files: [] })
    vi.spyOn(api, 'recentEvents').mockResolvedValue([])
    render(<ChatScreen id="c1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'More' }))
    expect(document.querySelector('[data-chat-end-why]')).toHaveTextContent(WHY_NOT_OURS)
    expect(screen.queryByRole('button', { name: 'End this chat…' })).toBeNull()
  })
})

describe('the phone home', () => {
  function stubs(sessions: SessionSummary[], chats: SessionSummary[] = []) {
    location.hash = '#/'
    vi.spyOn(api, 'sessionsWithTotal').mockResolvedValue({ items: sessions, total: sessions.length })
    vi.spyOn(projectsApi, 'list').mockResolvedValue([])
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [], max: 500 })
    vi.spyOn(api, 'work').mockResolvedValue({ now: NOW, day_start: NOW, sessions: [], hive: 'off', queued: [], repos: [], totals: { live: 0, working: 0, waiting_you: 0, today_usd: 0, machine_today_usd: 0 } })
    vi.spyOn(api, 'subscriptions').mockResolvedValue({ agents: [] } as unknown as Awaited<ReturnType<typeof api.subscriptions>>)
    vi.spyOn(api, 'chats').mockResolvedValue({ items: chats, total: chats.length, chats: chats.length, archived: 0 })
  }

  it('ends a session from Continue; the row then reads ended', async () => {
    stubs([work('alpha'), work('beta', { owned: false })])
    const signal = vi.spyOn(api, 'signal').mockResolvedValue(undefined)
    render(<PhoneHome />)
    await screen.findByText('work in alpha')
    fireEvent.click(screen.getByRole('button', { name: 'More for alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'End session…' }))
    fireEvent.click(screen.getByRole('button', { name: 'End session' }))
    await waitFor(() => expect(signal).toHaveBeenCalledWith('alpha', 'end'))
    await waitFor(() => expect(screen.getByRole('link', { name: /work in alpha/ })).toHaveTextContent(/ended/))
    // The terminal's own session: the reason, and no End.
    fireEvent.click(screen.getByRole('button', { name: 'More for beta' }))
    expect(screen.getByRole('menu')).toHaveTextContent(WHY_NOT_OURS)
    expect(signal).toHaveBeenCalledTimes(1)
  })

  it('ends a chat from the home’s Chats', async () => {
    stubs([], [chat('c9')])
    const signal = vi.spyOn(api, 'signal').mockResolvedValue(undefined)
    render(<PhoneHome />)
    fireEvent.click(await screen.findByRole('button', { name: 'More for Trial c9' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'End session…' }))
    fireEvent.click(screen.getByRole('button', { name: 'End session' }))
    await waitFor(() => expect(signal).toHaveBeenCalledWith('c9', 'end'))
    await waitFor(() => expect(screen.getByRole('link', { name: /Trial c9/ })).toHaveTextContent(/ended/))
  })
})
