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
  handoff: vi.fn(async (project: string) => ({ project, memories: [], max: 5, budget: 700 })),
  glance: vi.fn((): Promise<unknown> => Promise.resolve({ agents: [], display: {} })),
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { ...actual.api, dropBrain: m.drop, brainStatus: m.status, brain: m.brain, brainNode: m.node, premium: m.premium, brainSettings: m.settings, brainBackfill: m.backfill, brainHandoff: m.handoff, glance: m.glance },
  }
})

import { ApiError, type BrainAutoStatus, type BrainNode, type BrainStatus } from '@/lib/api'
import { BrainCaptureHost } from './BrainCapture'
import { BrainDropButton } from './BrainDrop'
import { brainMode, openBrainCapture } from '@/lib/brain'
import { BrainScreen } from '@/screens/brain/BrainScreen'
import { BrainAutoSetting } from './BrainAutoSetting'
import { BrainSidebar } from './BrainSidebar'

const node = (over: Partial<BrainNode>): BrainNode => ({
  id: 1, kind: 'decision', title: 'Keep SQLite', summary: '', source: {}, manual: true, pinned: false, created_at: Date.now(), updated_at: Date.now(), ...over,
})
const auto = (over: Partial<BrainAutoStatus> = {}): BrainAutoStatus => ({
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
    // The graph is a card; opened, it has a fit button and a legend drawn as the graph is.
    fireEvent.click(await screen.findByRole('button', { name: /Open the graph/ }))
    expect(screen.getByRole('img', { name: /Second Brain graph: 3 nodes/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Fit the graph' })).toBeTruthy()
    expect(document.querySelector('[data-brain-legend]')!.textContent).toMatch(/a memory.*a topic.*a project/)
    // Beside it, what the graph holds, in counts of what was read.
    expect(document.querySelector('[data-brain-figures-graph]')!.textContent).toBe('1memory1topic1project2links')
    fireEvent.click(screen.getByRole('button', { name: 'Close the graph' }))
    const row = await screen.findByRole('button', { name: /Keep SQLite/ })
    expect(row.textContent).toContain('storage')
    // A project is the row's own column, not a topic.
    expect(row.textContent?.match(/caprock/g)?.length).toBe(1)
    fireEvent.click(row)
    await screen.findByText('WAL is enough for one machine.')
    expect(screen.getByRole('link', { name: /the session/ }).getAttribute('href')).toBe('#/session/s1?at=5')
  })

  it('searches as one types, marks the matched words in the list and says when close matches are in', async () => {
    m.status.mockResolvedValue(status())
    m.brain.mockImplementation(async (f: { q?: string }) => f.q
      ? {
          nodes: [
            node({ id: 1, title: 'Move the office to Αθήνα', rank: 40 }),
            node({ id: 2, title: 'Athens trip, the relase notes', rank: 15, close: true }),
          ],
          edges: [],
          total: 2,
          terms: ['αθηνα', 'release', 'relase'],
          close: true,
        }
      : { nodes: [node({ id: 1, title: 'Move the office to Αθήνα' })], edges: [], total: 1 })
    render(<BrainScreen />)
    // The search shows once the status says there is something to search.
    const box = await screen.findByRole('textbox', { name: 'Search memories' })
    expect(box.getAttribute('placeholder')).toBe('Search titles and summaries — typos are fine')
    fireEvent.change(box, { target: { value: 'ΑΘΗΝΑ release' } })
    await waitFor(() => expect(m.brain).toHaveBeenCalledWith(expect.objectContaining({ q: 'ΑΘΗΝΑ release' })))
    await screen.findByText(/including close matches/)
    expect(screen.getByText(/2 memories match/)).toBeTruthy()
    const marks = [...document.querySelectorAll('[data-brain-row] mark[data-match]')].map((e) => e.textContent)
    expect(marks).toEqual(['Αθήνα', 'relase'])
    // Best first, as the daemon ranked them.
    const rows = [...document.querySelectorAll('[data-brain-row]')].map((e) => e.getAttribute('data-brain-row'))
    expect(rows).toEqual(['1', '2'])
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

  it('is a banner while empty and off: the agents and the brain, Free, the line, Start building, How it works, no bare zero, nothing sent', async () => {
    m.status.mockResolvedValue(status({ memories: 0, manual: 0, auto: auto({ chosen: false, on: false, enabled: false, pending: 0 }) }))
    m.brain.mockResolvedValue({ nodes: [], edges: [], total: 0 })
    localStorage.setItem('caprock.app.brain-fold', 'open') // unfolded by this viewer
    render(<BrainSidebar onOpen={vi.fn()} />)
    await screen.findByRole('button', { name: 'Start building' })
    expect(document.querySelector('[data-brain-banner="off"]')).not.toBeNull()
    expect(document.querySelector('[data-brain-banner] [data-brain-hero] [data-brain-mark]')).not.toBeNull()
    expect(document.querySelector('[data-brain-banner] [data-brain-free]')!.textContent).toBe('Free')
    expect(screen.getByText('One memory for all your agents')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'How it works' })).toBeTruthy()
    expect(screen.queryByText(/Jarvis/)).toBeNull()
    expect(document.querySelector('[data-brain-count]')).toBeNull()
    expect(m.settings).not.toHaveBeenCalled()
  })

  it('Start building in the sidebar sends nothing and takes you to the screen, where the one-click start is', async () => {
    m.status.mockResolvedValue(status({ memories: 0, manual: 0, auto: auto({ chosen: false, on: false, enabled: false, pending: 0 }) }))
    m.brain.mockResolvedValue({ nodes: [], edges: [], total: 0 })
    const onOpen = vi.fn()
    localStorage.setItem('caprock.app.brain-fold', 'open') // unfolded by this viewer
    render(<BrainSidebar onOpen={onOpen} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start building' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('#/brain')
    // No wall of consent in the narrow column, and nothing sent from it.
    expect(document.querySelector('[data-brain-sidebar-consent]')).toBeNull()
    expect(m.settings).not.toHaveBeenCalled()
    expect(m.backfill).not.toHaveBeenCalled()
  })

  // Owner, 2026-10-15: with a long list of sessions the line under the orb
  // was cut off by the footer. The card is capped and the orb gives way.
  it('keeps its status line whole: the card is capped, the orb shrinks, the line does not', async () => {
    m.status.mockResolvedValue(status({ memories: 4, manual: 0, auto: auto({ pending: 0, spent: 1000 }) }))
    m.brain.mockResolvedValue({ nodes: [1, 2, 3, 4].map((id) => node({ id, title: `Memory ${id}` })), edges: [], total: 4 })
    localStorage.setItem('caprock.app.brain-fold', 'open') // unfolded by this viewer
    render(<BrainSidebar onOpen={vi.fn()} working={3} />)
    await waitFor(() => expect(document.querySelector('[data-brain-orb]')).not.toBeNull())
    const section = document.querySelector('[data-brain-sidebar]')!
    // It gives way before the list, down to a floor that holds the line.
    expect(section).toHaveClass('flex', 'flex-col', 'shrink-[20]', 'min-h-[136px]')
    expect(document.querySelector('[data-brain-block]')).toHaveClass('flex', 'flex-col', 'min-h-0')
    expect(document.querySelector('[data-brain-card]')).toHaveClass('flex', 'flex-col', 'min-h-0')
    expect(document.querySelector('[data-brain-orb]')).toHaveClass('h-[120px]', 'min-h-[64px]', 'shrink')
    expect(document.querySelector('[data-brain-status]')).toHaveClass('shrink-0')
  })

  // Owner, 2026-10-15, translated: "compact but interactive, not grabbing
  // attention". Folded by default; a saved fold is kept.
  it('starts folded: one quiet row, a still glyph and the mode in words; the chevron unfolds the calm brain, remembered', async () => {
    const t = Date.now()
    m.status.mockResolvedValue(status({ memories: 4, manual: 0, auto: auto({ pending: 0, spent: 1000 }) }))
    m.brain.mockResolvedValue({
      nodes: [1, 2, 3, 4].map((id) => node({ id, title: `Memory ${id}`, created_at: t - id * 1000 })).concat(node({ id: 9, kind: 'topic', title: 'storage' })),
      edges: [],
      total: 4,
    })
    const { unmount } = render(<BrainSidebar onOpen={vi.fn()} />)
    const row = await waitFor(() => { const r = document.querySelector('[data-brain-row]'); expect(r).not.toBeNull(); return r! })
    expect(localStorage.getItem('caprock.app.brain-fold')).toBeNull()
    expect(document.querySelector('[data-brain-orb]')).toBeNull()
    expect(row.querySelector('[data-brain-mode]')!.textContent).toBe('Second Brain · Up to date · 4 memories')
    expect(row.querySelector('[data-brain-mode]')).toHaveClass('text-fg-muted')
    expect(row.querySelector('[data-brain-glyph]')).toHaveAttribute('data-brain-glyph', 'still')
    expect(row.querySelector('.brain-glyph-reading, .brain-live-dot')).toBeNull()
    expect(document.querySelector('[data-brain-block]')!.className).toMatch(/hover:-translate-y-px/)
    fireEvent.click(screen.getByRole('button', { name: 'Unfold Second Brain' }))
    expect(localStorage.getItem('caprock.app.brain-fold')).toBe('open')
    await waitFor(() => expect(document.querySelector('[data-brain-orb]')).not.toBeNull())
    expect(m.brain).toHaveBeenCalledWith({ limit: 30 })
    expect(screen.getByRole('heading', { name: 'Second Brain' })).toBeTruthy()
    const line = document.querySelector('[data-brain-card] [data-brain-mode]')!
    expect(line.textContent).toBe('Up to date')
    expect(line.parentElement!.textContent).toMatch(/· updated/)
    fireEvent.click(screen.getByRole('button', { name: 'Fold Second Brain' }))
    expect(localStorage.getItem('caprock.app.brain-fold')).toBe('closed')
    expect(document.querySelector('[data-brain-orb]')).toBeNull()
    unmount()
    // A viewer who unfolded it keeps it unfolded.
    localStorage.setItem('caprock.app.brain-fold', 'open')
    render(<BrainSidebar onOpen={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('[data-brain-orb]')).not.toBeNull())
  })

  it('is one interactive card: a click anywhere or Enter opens the screen; the chevron only folds', async () => {
    m.status.mockResolvedValue(status({ memories: 4, auto: auto({ pending: 0 }) }))
    m.brain.mockResolvedValue({ nodes: [node({ id: 7, title: 'Memory 7' })], edges: [], total: 1 })
    const onOpen = vi.fn()
    localStorage.setItem('caprock.app.brain-fold', 'open') // unfolded by this viewer
    render(<BrainSidebar onOpen={onOpen} />)
    const block = await screen.findByRole('link', { name: /^Open Second Brain — Up to date/ })
    expect(block.tabIndex).toBe(0)
    fireEvent.click(screen.getByRole('heading', { name: 'Second Brain' }))
    expect(onOpen).toHaveBeenLastCalledWith('#/brain')
    fireEvent.click(document.querySelector('[data-brain-orb]')!)
    expect(onOpen).toHaveBeenCalledTimes(2)
    onOpen.mockClear()
    fireEvent.keyDown(block, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('#/brain')
    onOpen.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Fold Second Brain' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unfold Second Brain' }))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('says what it does now while it builds — the session’s project, how far — over a thin bar; folded, the mode keeps the room', async () => {
    m.status.mockResolvedValue(status({
      memories: 8, manual: 0,
      auto: auto({
        pending: 29, reading: { session_id: 's9', title: 'Fix the flaky cache test', project: 'acme-api', started_at: Date.now() },
        backfill_since: Date.now() - 30 * 86_400_000,
        build: { from: Date.now() - 30 * 86_400_000, sessions: 41, read: 11, memories: 8, sources: [] },
      }),
    }))
    m.brain.mockResolvedValue({ nodes: [node({ id: 1 })], edges: [], total: 1 })
    localStorage.setItem('caprock.app.brain-fold', 'open') // unfolded by this viewer
    render(<BrainSidebar onOpen={vi.fn()} />)
    await screen.findByText('Reading acme-api…')
    expect(screen.getByText('· 12 of 41')).toBeTruthy()
    expect(document.querySelector('[data-brain-sidebar-live] [role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('27')
    fireEvent.click(screen.getByRole('button', { name: 'Fold Second Brain' }))
    // Folded while it reads: what it does, and the glyph is the one thing that moves.
    const row = document.querySelector('[data-brain-row]')!
    expect(row.querySelector('[data-brain-mode]')!.textContent).toBe('Building · 12 of 41')
    expect(row.querySelector('[data-brain-mode]')!.getAttribute('title')).toBe('Building · reading session 12 of 41 — Fix the flaky cache test')
    expect(row.querySelector('[data-brain-row-bar]')!.getAttribute('aria-valuenow')).toBe('27')
    expect(row.querySelector('[data-brain-glyph]')).toHaveClass('brain-glyph-reading')
  })

  it('names each mode in words: paused, needs Claude Code, sessions to read, linking, limit reached', () => {
    const st = (a: Partial<BrainAutoStatus>, memories = 3) => status({ memories, auto: auto(a) }) as BrainStatus
    expect(brainMode(st({ on: false, chosen: true })).mode).toBe('Paused')
    expect(brainMode({ ...st({ on: false, chosen: false }, 0), notes: 2 })).toEqual({ mode: 'Obsidian', metric: '2 notes', active: false })
    expect(brainMode(st({ on: false, chosen: false }), 0).mode).toBe('Not started')
    expect(brainMode(st({ claude_found: false })).mode).toBe('Needs Claude Code')
    expect(brainMode(st({ pending: 3 })).mode).toBe('3 sessions to read')
    expect(brainMode(st({ pending: 3, spent: 300_000 })).mode).toBe('Today’s limit reached')
    expect(brainMode(st({ reading: { session_id: 's', project: 'web', started_at: 1, phase: 'linking' } })).mode).toBe('Linking web')
    expect(brainMode(st({ pending: 0, spent: 300_000 })).mode).toBe('Today’s limit reached')
    expect(brainMode(st({ pending: 0 }), 2).metric).toBe('3 · +2 today')
  })
})
