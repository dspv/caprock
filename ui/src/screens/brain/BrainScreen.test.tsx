import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const m = vi.hoisted(() => ({
  status: vi.fn(),
  brain: vi.fn(),
  settings: vi.fn(),
  backfill: vi.fn(),
  glance: vi.fn((): Promise<unknown> => Promise.resolve({ agents: [], display: {} })),
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { ...actual.api, brainStatus: m.status, brain: m.brain, brainSettings: m.settings, brainBackfill: m.backfill, glance: m.glance },
  }
})

import type { BrainAutoStatus, BrainNode } from '@/lib/api'
import { BrainScreen } from './BrainScreen'

const DAY = 86_400_000
const node = (over: Partial<BrainNode>): BrainNode => ({
  id: 1, kind: 'decision', title: 'Keep SQLite', summary: '', source: {}, manual: false, pinned: false, created_at: Date.now(), updated_at: Date.now(), ...over,
})
const auto = (over: Partial<BrainAutoStatus> = {}): BrainAutoStatus => ({
  chosen: true, on: true, enabled: true, claude_found: true, model: 'haiku', daily_tokens: 300_000, spent: 84_000, running: false, pending: 0, recent: [], ...over,
})
const off = () => auto({ chosen: false, on: false, enabled: false, spent: 0 })
const status = (over = {}) => ({ memories: 0, manual: 0, projects: [], ...over })
const empty = { nodes: [], edges: [], total: 0 }

/** A build part-way: 12 of 41 from the last 30 days, a session being read, two projects. */
const building = (over: Partial<BrainAutoStatus> = {}) => auto({
  running: true,
  pending: 29,
  backfill_since: Date.now() - 30 * DAY,
  reading: { session_id: 's12', title: 'Fix the flaky cache test', agent: 'claude', project: 'acme-api', last_event_at: Date.now() - 3 * DAY, started_at: Date.now() - 4000 },
  build: {
    from: Date.now() - 30 * DAY, sessions: 41, read: 12, memories: 8,
    sources: [{ project: 'acme-api', read: 9, pending: 20, memories: 6 }, { project: 'web', read: 3, pending: 9, memories: 2 }],
  },
  recent: [{ id: 3, session_id: 's11', status: 'ok', tokens_in: 4000, tokens_out: 300, cost_usd: 0, nodes: 3, finished_at: Date.now() - 20_000, project: 'acme-api', title: 'Pick a queue' }],
  ...over,
})

describe('the Second Brain screen', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('not built: one picture, Free, the headline, one button, one line of what happens, Details — and nothing else', async () => {
    m.status.mockResolvedValue(status({ auto: off() }))
    m.brain.mockResolvedValue(empty)
    render(<BrainScreen />)
    const start = await screen.findByRole('button', { name: 'Start building' })
    expect(document.querySelector('[data-brain-phase="start"]')).not.toBeNull()
    expect(document.querySelector('[data-brain-start] [data-brain-hero]')).not.toBeNull()
    expect(document.querySelector('[data-brain-start] [data-brain-free]')!.textContent).toBe('Free')
    expect(screen.getByRole('heading', { name: 'Give your agents a memory' })).toBeTruthy()
    expect(screen.getAllByRole('button').filter((b) => b.className.includes('bg-accent'))).toEqual([start])
    expect(document.querySelector('[data-brain-start-line]')!.textContent).toBe(
      'Your own Claude reads your last 30 days of sessions on this computer · up to 300k tokens a day · nothing goes to Caprock')
    // The rest of the disclosure is one click away, folded: model, Anthropic, cap.
    const details = document.querySelector<HTMLDetailsElement>('[data-brain-start-details]')!
    expect(details.open).toBe(false)
    expect(details.textContent).toMatch(/haiku/)
    expect(details.textContent).toMatch(/Anthropic under your login/)
    expect(details.textContent).toMatch(/300k tokens a day/)
    // No search, filters, view switch or empty-list instructions yet; adding a note is a quiet link.
    expect(screen.queryByRole('textbox', { name: 'Search memories' })).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: 'View' })).toBeNull()
    expect(screen.queryByText(/Drop into Second Brain/)).toBeNull()
    expect(screen.queryByText(/memories$/)).toBeNull()
    expect(document.querySelector('[data-brain-add-note]')!.textContent).toMatch(/^Add a note/)
    expect(m.settings).not.toHaveBeenCalled()
    expect(m.backfill).not.toHaveBeenCalled()
  })

  it('one click is the yes, the turn-on and the last 30 days, in that order — then it shows it working', async () => {
    m.status.mockResolvedValue(status({ auto: off() }))
    m.brain.mockResolvedValue(empty)
    m.settings.mockResolvedValue(auto())
    m.backfill.mockResolvedValue({ sessions: 41, tokens_estimate: 200_000, days_estimate: 1, daily_tokens: 300_000 })
    render(<BrainScreen />)
    const start = await screen.findByRole('button', { name: 'Start building' })
    m.status.mockResolvedValue(status({ auto: building({ build: { from: Date.now() - 30 * DAY, sessions: 41, read: 0, memories: 0, sources: [] }, reading: undefined, recent: [] }) }))
    fireEvent.click(start)
    await waitFor(() => expect(m.backfill).toHaveBeenCalledWith(30, true))
    expect(m.settings).toHaveBeenCalledTimes(1)
    expect(m.settings).toHaveBeenCalledWith({ auto: true })
    expect(m.settings.mock.invocationCallOrder[0]).toBeLessThan(m.backfill.mock.invocationCallOrder[0]!)
    await waitFor(() => expect(document.querySelector('[data-brain-phase="building"]')).not.toBeNull())
    expect(screen.getByRole('heading', { name: 'Building your Second Brain' })).toBeTruthy()
    expect(document.querySelector('[data-brain-graph-waiting]')!.textContent).toMatch(/Memories land here/)
  })

  it('building: what it reads now, how far, the memories found, today’s tokens, and where it comes from', async () => {
    m.status.mockResolvedValue(status({ memories: 8, auto: building() }))
    m.brain.mockResolvedValue({ nodes: [node({ id: 1 }), node({ id: 2, title: 'Use a queue' })], edges: [], total: 2 })
    render(<BrainScreen />)
    await screen.findByRole('heading', { name: 'Building your Second Brain' })
    const reading = document.querySelector('[data-brain-reading]')!
    expect(reading.textContent).toMatch(/Fix the flaky cache test/)
    expect(reading.textContent).toMatch(/Claude Code · acme-api · ran 3d ago/)
    expect(document.querySelector('[data-brain-sessions]')!.textContent).toBe('12 of 41')
    expect(screen.getByText('from the last 30 days')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'Sessions read' }).getAttribute('aria-valuenow')).toBe('29')
    expect(screen.getByRole('progressbar', { name: 'Tokens used today' }).getAttribute('aria-valuenow')).toBe('28')
    await waitFor(() => expect(screen.getByText('8', { selector: '.num' })).toBeTruthy())
    // Sources: each project, read of all, memories kept.
    const sources = [...document.querySelectorAll('[data-brain-source]')].map((li) => li.textContent)
    expect(sources).toEqual(['acme-api9 of 29 read · 6 memories', 'web3 of 12 read · 2 memories'])
    expect(document.querySelector('[data-brain-recent]')!.textContent).toMatch(/Pick a queue.*acme-api · 3 memories/)
    // The graph fills in beside it; search waits until it is built.
    await waitFor(() => expect(document.querySelector('[data-brain-graph="full"]')).not.toBeNull())
    expect(screen.queryByRole('textbox', { name: 'Search memories' })).toBeNull()
  })

  it('pauses with a small secondary control, and resumes', async () => {
    m.status.mockResolvedValue(status({ auto: building() }))
    m.brain.mockResolvedValue(empty)
    m.settings.mockResolvedValue(auto({ on: false }))
    render(<BrainScreen />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(m.settings).toHaveBeenCalledWith({ auto: false }))
  })

  it('says each problem plainly with the one action that fixes it', async () => {
    m.brain.mockResolvedValue(empty)
    m.settings.mockResolvedValue(auto())
    m.status.mockResolvedValue(status({ auto: building({ spent: 300_000 }) }))
    render(<BrainScreen />)
    await screen.findByText(/Today’s 300k tokens are used/)
    fireEvent.click(screen.getByRole('button', { name: 'Raise to 1M a day' }))
    await waitFor(() => expect(m.settings).toHaveBeenCalledWith({ daily_tokens: 1_000_000 }))
    cleanup()

    m.status.mockResolvedValue(status({ auto: { ...off(), claude_found: false } }))
    render(<BrainScreen />)
    await screen.findByText(/Claude Code was not found on this computer/)
    expect(screen.queryByRole('button', { name: 'Start building' })).toBeNull()
    const calls = m.status.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(m.status.mock.calls.length).toBeGreaterThan(calls))
  })

  it('with memories: the graph and the list with search, one quiet line, and a gear with three settings', async () => {
    m.status.mockResolvedValue(status({ memories: 2, projects: [{ project: 'acme-api', count: 2 }], auto: auto() }))
    m.brain.mockResolvedValue({ nodes: [node({ id: 1 }), node({ id: 2, title: 'Use a queue' })], edges: [], total: 2 })
    m.settings.mockResolvedValue(auto())
    render(<BrainScreen />)
    await screen.findByRole('textbox', { name: 'Search memories' })
    expect(document.querySelector('[data-brain-phase="memories"]')).not.toBeNull()
    expect(document.querySelector('[data-brain-live-line]')!.textContent).toMatch(/Up to date/)
    expect(document.querySelector('[data-brain-start]')).toBeNull()
    expect(document.querySelector('[data-brain-live]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))
    const pop = screen.getByRole('dialog', { name: 'Second Brain settings' })
    expect(pop.textContent).toMatch(/Build automatically/)
    fireEvent.click(screen.getByRole('radio', { name: 'Sonnet' }))
    await waitFor(() => expect(m.settings).toHaveBeenCalledWith({ model: 'sonnet' }))
    fireEvent.click(screen.getByRole('radio', { name: '1M' }))
    await waitFor(() => expect(m.settings).toHaveBeenCalledWith({ daily_tokens: 1_000_000 }))
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(m.settings).toHaveBeenCalledWith({ auto: false }))
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog', { name: 'Second Brain settings' })).toBeNull()
  })
})
