/**
 * Chats (ADR-071): the list — newest first, counted, searchable, one tap to a
 * new chat on the remembered model, rename, archive, delete after a second
 * tap — and one chat: its conversation, its files and their viewer, the HTML
 * one in a frame that runs nothing.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type CatalogEntry, type ChatFile, type SessionDetail, type SessionSummary } from '@/lib/api'
import { ChatsScreen } from './Chats'
import { ChatScreen } from './Chat'
import { resetQuickReplies } from '@/lib/quickReplies'

const NOW = Date.now()

function chat(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: id, cwd: `/data/chats/2026-10-16-10101${id.slice(-1)}`, project: 'chat', status: 'ended', owned: true, chat: true,
    last_event_at: NOW - 60_000, worked_at: NOW - 60_000, agent: 'claude', model_display: 'Opus 5.5',
    description: `first message of ${id}`, description_source: 'prompt',
    activity: { health: 'idle', phrase: '', at: '' }, stats: {}, ...extra,
  } as unknown as SessionSummary
}

const claude: CatalogEntry = { id: 'claude', label: 'Claude Code', installed: true, ready: true, models: [], observed: true, prompt: true }

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  location.hash = '#/chats'
  vi.spyOn(api, 'agentCatalog').mockResolvedValue({ agents: [claude], licensed: false } as unknown as Awaited<ReturnType<typeof api.agentCatalog>>)
})

describe('ChatsScreen', () => {
  it('lists the chats, newest first, with their count and their first message as the title', async () => {
    vi.spyOn(api, 'chats').mockResolvedValue({ items: [chat('c1'), chat('c2', { name: 'Trip to Kyoto' })], total: 2, chats: 2, archived: 1 })
    render(<ChatsScreen />)
    const list = await screen.findByRole('list', { name: 'Chats' })
    const rows = within(list).getAllByRole('link')
    expect(rows.map((r) => r.getAttribute('href'))).toEqual(['#/chats/c1', '#/chats/c2'])
    expect(rows[0]!.textContent).toContain('First message of c1')
    expect(rows[1]!.textContent).toContain('Trip to Kyoto')
    expect(rows[0]!.textContent).toContain('Claude · Opus 5.5')
    expect(screen.getByLabelText('2 chats')).toBeTruthy()
    expect(screen.getByText('Archived · 1').closest('a')?.getAttribute('href')).toBe('#/chats?archived=1')
  })

  it('starts a new chat in one tap on the model picked last, and opens it', async () => {
    localStorage.setItem('caprock.quickchat', JSON.stringify({ agent: 'claude', model: 'claude-haiku-5-5' }))
    vi.spyOn(api, 'chats').mockResolvedValue({ items: [], total: 0, chats: 0, archived: 0 })
    const spawn = vi.spyOn(api, 'spawn').mockResolvedValue({ session_id: 'fresh', cwd: '/data/chats/x' })
    render(<ChatsScreen />)
    expect(await screen.findByText('No chats yet.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Model: Claude · Haiku 5\.5/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /New chat/ }))
    await waitFor(() => expect(spawn).toHaveBeenCalledWith({ chat: true, model: 'claude-haiku-5-5' }))
    await waitFor(() => expect(location.hash).toBe('#/chats/fresh'))
  })

  it('changes the model from the chip, remembered and starting nothing', async () => {
    vi.spyOn(api, 'chats').mockResolvedValue({ items: [], total: 0, chats: 0, archived: 0 })
    const spawn = vi.spyOn(api, 'spawn')
    render(<ChatsScreen />)
    fireEvent.click(await screen.findByRole('button', { name: /Model:/ }))
    const sheet = await screen.findByRole('dialog', { name: 'Model for new chats' })
    fireEvent.click(within(sheet).getByText('Sonnet 5.5'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Model for new chats' })).toBeNull())
    expect(screen.getByRole('button', { name: /Model: Claude · Sonnet 5\.5/ })).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('caprock.quickchat') ?? '{}')).toMatchObject({ agent: 'claude', model: 'claude-sonnet-5-5' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('searches the chats on the daemon', async () => {
    const list = vi.spyOn(api, 'chats').mockResolvedValue({ items: [chat('c1')], total: 1, chats: 1, archived: 0 })
    render(<ChatsScreen />)
    await screen.findByRole('list', { name: 'Chats' })
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'monad' } })
    await waitFor(() => expect(list).toHaveBeenCalledWith({ q: 'monad', archived: false, limit: 100 }))
  })

  it('archives a chat from its row, and deletes one only on a second, explicit tap', async () => {
    vi.spyOn(api, 'chats').mockResolvedValue({ items: [chat('c1'), chat('c2')], total: 2, chats: 2, archived: 0 })
    const archive = vi.spyOn(api, 'archiveChat').mockResolvedValue({ session_id: 'c1', archived_at: NOW })
    const del = vi.spyOn(api, 'deleteChat').mockResolvedValue({ session_id: 'c2', folder_removed: true })
    render(<ChatsScreen />)
    await screen.findByRole('list', { name: 'Chats' })
    fireEvent.click(screen.getByRole('button', { name: 'More for First message of c1' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    await waitFor(() => expect(archive).toHaveBeenCalledWith('c1', true))
    await waitFor(() => expect(screen.queryByText('First message of c1')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'More for First message of c2' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    expect(del).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete for good/ }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('c2'))
    await waitFor(() => expect(screen.queryByText('First message of c2')).toBeNull())
  })

  it('renames a chat from its row', async () => {
    vi.spyOn(api, 'chats').mockResolvedValue({ items: [chat('c1')], total: 1, chats: 1, archived: 0 })
    const rename = vi.spyOn(api, 'renameSession').mockResolvedValue({ session_id: 'c1', name: 'Monads' })
    render(<ChatsScreen />)
    await screen.findByRole('list', { name: 'Chats' })
    fireEvent.click(screen.getByRole('button', { name: 'More for First message of c1' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.change(screen.getByLabelText('Chat name'), { target: { value: '  Monads ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(rename).toHaveBeenCalledWith('c1', 'Monads'))
  })
})

describe('Import chats (ADR-074)', () => {
  it('imports an export the user picks, says what it did, and reads the list again', async () => {
    const list = vi.spyOn(api, 'chats').mockResolvedValue({ items: [], total: 0, chats: 0, archived: 0 })
    const imp = vi.spyOn(api, 'importChats').mockResolvedValue({
      conversations: 12, added: 3, updated: 1, unchanged: 8, deleted: 0, empty: 2, messages: 40, sources: { chatgpt: 12 },
    })
    render(<ChatsScreen />)
    await screen.findByText('No chats yet.')
    fireEvent.click(screen.getByRole('button', { name: 'How do I get the file?' }))
    expect(screen.getByText(/Settings → Data controls → Export data/)).toBeTruthy()
    expect(screen.getByText(/nothing is sent anywhere/)).toBeTruthy()
    const file = new File(['[]'], 'export.zip', { type: 'application/zip' })
    fireEvent.change(screen.getByLabelText('Export file'), { target: { files: [file] } })
    await waitFor(() => expect(imp).toHaveBeenCalledWith(file))
    expect(await screen.findByText('Read 12 conversations from ChatGPT: 3 new, 1 with new messages, 8 already here.')).toBeTruthy()
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1))
  })

  it('shows an imported chat with its service, read-only, with no files', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({
      ...chat('c9', { agent: 'chatgpt', owned: false, cwd: '', model_display: '', title: 'Packing list for a hike' }), events: [], files: [], prs: [],
    } as unknown as SessionDetail)
    const files = vi.spyOn(api, 'chatFiles').mockRejectedValue(new Error('404'))
    vi.spyOn(api, 'recentEvents').mockResolvedValue([])
    render(<ChatScreen id="c9" />)
    expect(await screen.findByRole('heading', { name: 'Packing list for a hike' })).toBeTruthy()
    expect(screen.getByText(/ChatGPT · ended/)).toBeTruthy()
    expect(await screen.findByText(/Imported from ChatGPT/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Files/ })).toBeNull()
    expect(screen.queryByPlaceholderText('Message…')).toBeNull()
    expect(files).toHaveBeenCalled()
  })
})

describe('ChatScreen', () => {
  const files: ChatFile[] = [
    { path: 'page.html', size: 120, modified: NOW - 1000, kind: 'html' },
    { path: 'notes.md', size: 40, modified: NOW - 2000, kind: 'markdown' },
  ]
  function stub(extra: Partial<SessionSummary> = {}) {
    vi.spyOn(api, 'session').mockResolvedValue({ ...chat('c1', extra), events: [], files: [], prs: [] } as unknown as SessionDetail)
    vi.spyOn(api, 'chatFiles').mockResolvedValue({ files })
    vi.spyOn(api, 'recentEvents').mockResolvedValue([])
  }

  it('shows the chat as a conversation, with its model and its files counted', async () => {
    stub()
    render(<ChatScreen id="c1" />)
    expect(await screen.findByRole('heading', { name: 'First message of c1' })).toBeTruthy()
    expect(screen.getByText(/Claude · Opus 5\.5 · ended/)).toBeTruthy()
    expect(document.querySelector('[data-chat-view]')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Files · 2' })).toBeTruthy()
    expect(screen.getByText(/This chat has ended/)).toBeTruthy()
  })

  it('has a messenger’s field, without the coding quick replies, while the chat is live', async () => {
    stub({ status: 'active', owned: true })
    resetQuickReplies([{ label: 'Continue', text: 'Continue.' }, { label: 'Run tests', text: 'Run the tests and fix what fails.' }])
    render(<ChatScreen id="c1" />)
    expect(await screen.findByPlaceholderText('Message…')).toBeTruthy()
    const row = screen.getByRole('group', { name: 'Quick replies' })
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Continue'])
    resetQuickReplies()
  })

  it('opens an HTML file in a frame that runs no script and fetches nothing, with Download', async () => {
    stub()
    vi.spyOn(api, 'chatFile').mockResolvedValue(new Blob(['<h1>Report</h1><script>alert(1)</script>'], { type: 'text/html' }))
    render(<ChatScreen id="c1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Files · 2' }))
    const sheet = await screen.findByRole('dialog', { name: 'Files · 2' })
    fireEvent.click(within(sheet).getByText('page.html'))
    const viewer = await screen.findByRole('dialog', { name: 'page.html' })
    const frame = await waitFor(() => {
      const f = viewer.querySelector('iframe')
      if (!f) throw new Error('no frame yet')
      return f
    })
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'")
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Report</h1>')
    expect(within(viewer).getByRole('button', { name: 'Download' })).toBeTruthy()
  })

  it('renders a Markdown file', async () => {
    stub()
    vi.spyOn(api, 'chatFile').mockResolvedValue(new Blob(['# Findings\n\nAll good.'], { type: 'text/markdown' }))
    render(<ChatScreen id="c1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Files · 2' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Files · 2' })).getByText('notes.md'))
    const viewer = await screen.findByRole('dialog', { name: 'notes.md' })
    expect(await within(viewer).findByRole('heading', { name: 'Findings' })).toBeTruthy()
  })

  it('carries an ended chat on in its own folder', async () => {
    stub({ resume: { ok: true } } as Partial<SessionSummary>)
    const spawn = vi.spyOn(api, 'spawn').mockResolvedValue({ session_id: 'c1', cwd: '/data/chats/2026-10-16-101011' })
    render(<ChatScreen id="c1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue this chat' }))
    await waitFor(() => expect(spawn).toHaveBeenCalledWith({ cwd: '/data/chats/2026-10-16-101011', resume: 'c1', fork: false }))
  })
})
