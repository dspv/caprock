import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const m = vi.hoisted(() => ({
  drop: vi.fn(),
  status: vi.fn(),
  brain: vi.fn(),
  node: vi.fn(),
  premium: vi.fn(),
  settings: vi.fn(),
  backfill: vi.fn(),
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { ...actual.api, dropBrain: m.drop, brainStatus: m.status, brain: m.brain, brainNode: m.node, premium: m.premium, brainSettings: m.settings, brainBackfill: m.backfill },
  }
})

import { ApiError, type BrainNode } from '@/lib/api'
import { BrainCaptureHost } from './BrainCapture'
import { BrainDropButton } from './BrainDrop'
import { openBrainCapture } from '@/lib/brain'
import { BrainScreen } from '@/screens/brain/BrainScreen'
import { BrainAutoSetting } from './BrainAutoSetting'
import { BrainSidebar } from './BrainSidebar'

const node = (over: Partial<BrainNode>): BrainNode => ({
  id: 1, kind: 'decision', title: 'Keep SQLite', summary: '', source: {}, manual: true, pinned: false, created_at: Date.now(), updated_at: Date.now(), ...over,
})
const auto = (over = {}) => ({
  chosen: true, on: true, enabled: true, claude_found: true, model: 'haiku', daily_tokens: 300_000, spent: 12_000, running: false, pending: 2, recent: [], ...over,
})
const status = (over = {}) => ({ memories: 1, manual: 1, projects: [], ...over })

describe('Second Brain', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('opens the quick capture from anywhere and drops the line in', async () => {
    m.status.mockResolvedValue(status())
    m.drop.mockResolvedValue({ node: node({}), created: true })
    render(<BrainCaptureHost />)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => openBrainCapture('Try a Bloom filter'))
    const field = await screen.findByRole('textbox', { name: /What to keep/ })
    expect((field as HTMLTextAreaElement).value).toBe('Try a Bloom filter')
    fireEvent.click(screen.getByRole('radio', { name: 'Finding' }))
    fireEvent.change(screen.getByPlaceholderText('sqlite, pricing'), { target: { value: 'dedupe, , bloom ' } })
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(m.drop).toHaveBeenCalledWith({ text: 'Try a Bloom filter', kind: 'finding', topics: ['dedupe', 'bloom'] }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('has no allowance and no upsell: the capture is the same at any count', async () => {
    m.status.mockResolvedValue(status({ memories: 250, manual: 250 }))
    m.drop.mockResolvedValue({ node: node({}), created: true })
    render(<BrainCaptureHost />)
    act(() => openBrainCapture('the 251st'))
    await screen.findByRole('textbox', { name: /What to keep/ })
    expect(screen.getByText('Kept on this machine.')).toBeTruthy()
    expect(screen.queryByText(/free memories|Premium/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Drop it in/ }))
    await waitFor(() => expect(m.drop).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('says a failed drop plainly, with nothing to buy', async () => {
    m.drop.mockRejectedValue(new ApiError(500, '500', { error: 'disk full' }))
    render(<BrainDropButton eventId={7} />)
    fireEvent.click(screen.getByRole('button', { name: 'Drop into Second Brain' }))
    await screen.findByText('Could not drop')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('drops an answer by its event id and says it is kept', async () => {
    m.drop.mockResolvedValue({ node: node({}), created: true })
    render(<BrainDropButton eventId={42} />)
    fireEvent.click(screen.getByRole('button', { name: 'Drop into Second Brain' }))
    await screen.findByRole('button', { name: 'In Second Brain' })
    expect(m.drop).toHaveBeenCalledWith({ event_id: 42 })
  })

  it('lists memories with their topics and opens one', async () => {
    m.status.mockResolvedValue(status({ projects: [{ project: 'caprock', count: 1 }] }))
    m.brain.mockResolvedValue({
      nodes: [node({ id: 1, source: { project: 'caprock' } }), node({ id: 2, kind: 'topic', title: 'storage' }), node({ id: 3, kind: 'project', title: 'caprock' })],
      edges: [{ from: 1, to: 2, kind: 'part_of', weight: 1 }, { from: 1, to: 3, kind: 'part_of', weight: 1 }],
      total: 1,
    })
    m.node.mockResolvedValue({ node: node({ id: 1, summary: 'WAL is enough for one machine.', source: { session_id: 's1', ts: 5, project: 'caprock' } }), links: [] })
    render(<BrainScreen />)
    // Its name in full, with its mark and the one line on what it is.
    const title = screen.getByRole('heading', { level: 1, name: 'Second Brain' })
    expect(title.querySelector('svg')).not.toBeNull()
    expect(screen.getByText('Remembers what your agents learn — so the next one starts smarter.')).toBeTruthy()
    // The graph first; the list a click away, and remembered.
    await waitFor(() => expect(document.querySelector('[data-brain-graph="full"]')).not.toBeNull())
    expect(screen.getByRole('img', { name: /Second Brain graph: 3 nodes/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'List' }))
    expect(localStorage.getItem('caprock-brain-view')).toBe('list')
    const row = await screen.findByRole('button', { name: /Keep SQLite/ })
    expect(row.textContent).toContain('storage')
    // A project is the row's own column, not a topic.
    expect(row.textContent?.match(/caprock/g)?.length).toBe(1)
    fireEvent.click(row)
    await screen.findByText('WAL is enough for one machine.')
    expect(screen.getByRole('link', { name: /the session/ }).getAttribute('href')).toBe('#/session/s1?at=5')
  })

  it('asks everyone once, on the Brain screen, whether to build it automatically; no Premium anywhere', async () => {
    m.status.mockResolvedValue(status({ auto: auto({ chosen: false, on: false, enabled: false }) }))
    m.brain.mockResolvedValue({ nodes: [], edges: [], total: 0 })
    m.settings.mockResolvedValue(auto())
    render(<BrainScreen />)
    await screen.findByText(/Build it from your sessions automatically/)
    expect(screen.getByText(/Nothing is sent to Caprock/)).toBeTruthy()
    expect(screen.queryByText(/Premium|free memories/)).toBeNull()
    m.status.mockResolvedValue(status({ auto: auto() }))
    fireEvent.click(screen.getByRole('button', { name: 'Turn it on' }))
    await waitFor(() => expect(m.settings).toHaveBeenCalledWith({ auto: true }))
    await waitFor(() => expect(screen.queryByText(/Build it from your sessions automatically/)).toBeNull())
  })

  it('shows its figures and estimates a backfill before starting it', async () => {
    m.status.mockResolvedValue(status({ auto: auto() }))
    m.backfill.mockResolvedValueOnce({ sessions: 12, tokens_estimate: 90_000, days_estimate: 1, daily_tokens: 300_000 })
    m.backfill.mockResolvedValueOnce({ sessions: 12, tokens_estimate: 90_000, days_estimate: 1, daily_tokens: 300_000 })
    render(<BrainAutoSetting />)
    await screen.findByText(/2 sessions waiting to be read/)
    fireEvent.click(screen.getByRole('button', { name: 'Build from my last 30 days' }))
    await screen.findByText(/12 sessions to read/)
    expect(m.backfill).toHaveBeenLastCalledWith(30)
    expect(screen.getByText(/An estimate/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(m.backfill).toHaveBeenLastCalledWith(30, true))
    await screen.findByText(/Started/)
  })

  it('keeps a Second Brain block in the sidebar: its name, mark and line, the newest titles, the count, and a way in', async () => {
    m.status.mockResolvedValue(status({ memories: 4 }))
    m.brain.mockResolvedValue({
      nodes: [1, 2, 3, 4].map((id) => node({ id, title: `Memory ${id}`, created_at: id })).concat(node({ id: 9, kind: 'topic', title: 'storage' })),
      edges: [],
      total: 4,
    })
    const onOpen = vi.fn()
    render(<BrainSidebar onOpen={onOpen} />)
    await screen.findByRole('button', { name: 'Memory 4' })
    expect(m.brain).toHaveBeenCalledWith({ limit: 30 })
    // Named in full, with its mark and the one line on what it is.
    const heading = screen.getByRole('heading', { name: 'Second Brain' })
    expect(heading.querySelector('svg')).not.toBeNull()
    expect(screen.getByText('Remembers what your agents learn — so the next one starts smarter.')).toBeTruthy()
    // The three newest, newest first; topics are not titles here.
    expect(screen.getAllByRole('button').map((b) => b.textContent).filter((t) => t?.startsWith('Memory'))).toEqual(['Memory 4', 'Memory 3', 'Memory 2'])
    fireEvent.click(screen.getByRole('button', { name: 'Memory 3' }))
    expect(onOpen).toHaveBeenCalledWith('#/brain?node=3')
    fireEvent.click(screen.getByRole('button', { name: 'Fold Second Brain' }))
    expect(screen.queryByRole('button', { name: 'Memory 4' })).toBeNull()
    expect(localStorage.getItem('caprock.app.brain-fold')).toBe('closed')
  })

  it('starts unfolded for everyone, with no lock, and says how it works', async () => {
    m.status.mockResolvedValue(status({ memories: 2, manual: 2 }))
    m.brain.mockResolvedValue({ nodes: [node({ id: 1, title: 'Memory 1' })], edges: [], total: 1 })
    const onOpen = vi.fn()
    render(<BrainSidebar onOpen={onOpen} />)
    await screen.findByRole('button', { name: 'Memory 1' })
    expect(screen.getByRole('button', { name: 'Fold Second Brain' })).toBeTruthy()
    expect(document.querySelector('[data-brain-sidebar] svg.text-premium-strong')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'How it works' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).not.toMatch(/Premium|\$/)
    expect(m.premium).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open Second Brain' }))
    expect(onOpen).toHaveBeenCalledWith('#/brain')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('is a banner while empty and off: the line, Start building, How it works, no bare zero, nothing sent', async () => {
    m.status.mockResolvedValue(status({ memories: 0, manual: 0, auto: auto({ chosen: false, on: false, enabled: false, pending: 0 }) }))
    m.brain.mockResolvedValue({ nodes: [], edges: [], total: 0 })
    render(<BrainSidebar onOpen={vi.fn()} />)
    await screen.findByRole('button', { name: 'Start building' })
    expect(document.querySelector('[data-brain-banner="off"]')).not.toBeNull()
    expect(document.querySelector('[data-brain-ghost]')).not.toBeNull()
    expect(screen.getByText('Remembers what your agents learn — so the next one starts smarter.')).toBeTruthy()
    expect(screen.getByText('Local · your own Claude · free')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'How it works' })).toBeTruthy()
    expect(screen.queryByText(/Jarvis/)).toBeNull()
    expect(screen.queryByRole('button', { name: /memories — open Second Brain/ })).toBeNull()
    expect(m.settings).not.toHaveBeenCalled()
  })

  it('asks in place before it turns on, naming the model, the limit and where it goes; Turn on is the one call', async () => {
    m.status.mockResolvedValue(status({ memories: 0, manual: 0, auto: auto({ chosen: false, on: false, enabled: false, pending: 0 }) }))
    m.brain.mockResolvedValue({ nodes: [], edges: [], total: 0 })
    m.settings.mockResolvedValue(auto())
    m.backfill.mockResolvedValue({ sessions: 12, tokens_estimate: 90_000, days_estimate: 1, daily_tokens: 300_000 })
    render(<BrainSidebar onOpen={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start building' }))
    const consent = document.querySelector('[data-brain-sidebar-consent]')!
    expect(consent.textContent).toMatch(/haiku/)
    expect(consent.textContent).toMatch(/300k/)
    expect(consent.textContent).toMatch(/Nothing is sent to Caprock/)
    expect(consent.textContent).toMatch(/Settings → Second Brain/)
    expect(consent.textContent).toMatch(/starting with your last 30 days/)
    expect(m.settings).not.toHaveBeenCalled()
    expect(m.backfill).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(document.querySelector('[data-brain-sidebar-consent]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start building' }))
    m.status.mockResolvedValue(status({ memories: 0, manual: 0, auto: auto({ running: true }) }))
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(m.settings).toHaveBeenCalledWith({ auto: true }))
    expect(m.settings).toHaveBeenCalledTimes(1)
    // The yes reads from now on; the past month follows it, as the consent said.
    await waitFor(() => expect(m.backfill).toHaveBeenCalledWith(30, true))
    expect(m.settings.mock.invocationCallOrder[0]).toBeLessThan(m.backfill.mock.invocationCallOrder[0]!)
    await screen.findByText('Reading your recent sessions…')
  })

  it('offers no Turn on without claude, and says why', async () => {
    m.status.mockResolvedValue(status({ memories: 0, manual: 0, auto: auto({ chosen: false, on: false, enabled: false, claude_found: false }) }))
    m.brain.mockResolvedValue({ nodes: [], edges: [], total: 0 })
    render(<BrainSidebar onOpen={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start building' }))
    expect(screen.getByText(/Claude Code was not found/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull()
  })

  it('says what it is doing while on and still empty: sessions waiting, and the last problem', async () => {
    m.status.mockResolvedValue(status({ memories: 0, manual: 0, auto: auto({ pending: 3, last_error: 'claude exited 1' }) }))
    m.brain.mockResolvedValue({ nodes: [], edges: [], total: 0 })
    render(<BrainSidebar onOpen={vi.fn()} />)
    await screen.findByText('3 sessions waiting · first memories in a few minutes')
    expect(document.querySelector('[data-brain-banner="on"]')).not.toBeNull()
    expect(screen.getByText('Last problem: claude exited 1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start building' })).toBeNull()
    expect(screen.getByText('· building')).toBeTruthy()
  })
})
