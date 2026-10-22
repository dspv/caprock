import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const m = vi.hoisted(() => ({
  status: vi.fn(),
  brain: vi.fn(),
  settings: vi.fn(),
  backfill: vi.fn(),
  handoff: vi.fn(),
  node: vi.fn(),
  glance: vi.fn((): Promise<unknown> => Promise.resolve({ agents: [], display: {} })),
  spend: vi.fn((): Promise<unknown> => new Promise(() => {})),
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { ...actual.api, brainStatus: m.status, brain: m.brain, brainSettings: m.settings, brainBackfill: m.backfill, brainHandoff: m.handoff, brainNode: m.node, glance: m.glance, brainSpend: m.spend },
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
  reading: { session_id: 's12', title: 'Fix the flaky cache test', agent: 'claude', project: 'acme-api', last_event_at: Date.now() - 3 * DAY, started_at: Date.now() - 4000, phase: 'extracting', passages: 14 },
  new_today: 3, topics: 5, links: 17, spent_usd: 0.42,
  handoff: { on: true, sessions_24h: 2, memories_24h: 9, sessions: 6, memories: 27 },
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

  it('shows imported notes even when automatic extraction is off and no session memories exist', async () => {
    m.status.mockResolvedValue(status({ notes: 1, auto: off() }))
    m.brain.mockResolvedValue({ nodes: [node({ kind: 'note', title: 'Vault journal', vault: 'My notes' })], edges: [], total: 1 })
    m.handoff.mockResolvedValue({ project: '', memories: [], max: 5, budget: 700 })
    render(<BrainScreen />)
    expect(await screen.findByRole('heading', { name: 'Memories and notes' })).toBeVisible()
    expect(screen.getByRole('button', { name: /Vault journal/ })).toHaveTextContent('Obsidian')
    expect(document.querySelector('[data-brain-phase="memories"]')).not.toBeNull()
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
    expect(screen.getByRole('heading', { name: 'Building' })).toBeTruthy()
    expect(document.querySelector('[data-brain-state-detail]')!.textContent).toBe(' · 0 of 41 read · opening the next session · 0% · 0 memories')
    expect(document.querySelector('[data-brain-list-waiting]')!.textContent).toMatch(/Memories land here/)
    // Before the first memory the card is the living brain, not a graph to open.
    expect(document.querySelector('[data-brain-graph-card="waiting"] [data-brain-live-orb]')).not.toBeNull()
  })

  it('building: one line with N of M over a bar; what it reads, the steps, tokens and sources under Details', async () => {
    m.status.mockResolvedValue(status({ memories: 8, auto: building() }))
    m.brain.mockResolvedValue({ nodes: [node({ id: 1 }), node({ id: 2, title: 'Use a queue' })], edges: [], total: 2 })
    m.handoff.mockResolvedValue({ project: '', memories: [], max: 5, budget: 700 })
    render(<BrainScreen />)
    await screen.findByRole('heading', { name: 'Building' })
    // One line: the state, N of M, the share and the memories so far, over a bar.
    expect(document.querySelector('[data-brain-state-detail]')!.textContent).toBe(' · reading session 13 of 41 · 29% · 8 memories')
    expect(screen.getByRole('progressbar', { name: 'Build progress' }).getAttribute('aria-valuenow')).toBe('29')
    // No step blocks or tiles on the page until Details is opened.
    expect(document.querySelector('[data-brain-steps], [data-brain-figures]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect([...document.querySelectorAll('[data-brain-step]')].map((s) => s.getAttribute('data-brain-step-state'))).toEqual(['done', 'now', 'idle'])
    expect(document.querySelector('[data-brain-step-reading]')!.textContent).toMatch(/Fix the flaky cache test.*Claude Code · acme-api · 14 passages · 4s/)
    const figures = [...document.querySelectorAll('[data-brain-figures] dd')].map((d) => d.textContent)
    expect(figures).toEqual(['12 of 41 read · last 30 days', '17', '84k of 300k', '$0.42 API list price'])
    const sources = [...document.querySelectorAll('[data-brain-source]')].map((li) => li.textContent)
    expect(sources).toEqual(['acme-api9 of 29 read · 6 memories', 'web3 of 12 read · 2 memories'])
    expect(document.querySelector('[data-brain-recent]')!.textContent).toMatch(/Pick a queue.*acme-api · 3 memories/)
    // With memories, the graph is a card that opens, and the list is there.
    await waitFor(() => expect(document.querySelector('[data-brain-graph="mini"]')).not.toBeNull())
    expect(document.querySelector('[data-brain-graph="full"]')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Search memories' })).toBeTruthy()
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

  it('with memories: one status line, what the next session gets, the recent list, and a gear with three settings', async () => {
    m.status.mockResolvedValue({ ...status({ memories: 2, projects: [{ project: 'acme-api', count: 2 }], auto: auto({ stage: 'up_to_date', last_read: Date.now() - 60_000, new_today: 1, topics: 3, spent_usd: 0.15, handoff: { on: false, sessions_24h: 0, memories_24h: 0, sessions: 0, memories: 0 } }) }), db_path: 'C:\\Users\\me\\AppData\\Roaming\\caprock\\caprock.db' })
    m.brain.mockResolvedValue({ nodes: [node({ id: 1, source: { project: 'acme-api' } }), node({ id: 2, title: 'Use a queue' })], edges: [], total: 2 })
    m.handoff.mockResolvedValue({ project: 'acme-api', memories: [node({ id: 1, summary: 'WAL is enough.', source: { project: 'acme-api' } })], max: 5, budget: 700, served: { on: false, holdout_pct: 25 } })
    m.settings.mockResolvedValue(auto())
    render(<BrainScreen />)
    await screen.findByRole('textbox', { name: 'Search memories' })
    expect(document.querySelector('[data-brain-phase="memories"]')).not.toBeNull()
    expect(document.querySelector('[data-brain-state]')!.textContent).toBe('Up to date')
    expect(document.querySelector('[data-brain-state]')!.getAttribute('title')).toMatch(/^Last built \d\d:\d\d$/)
    expect(document.querySelector('[data-brain-state-detail]')!.textContent).toBe(' · 2 memories · 1 new today · 3 topics · $0.15 in 24 h')
    expect(document.querySelector('[data-brain-strip]')!.getAttribute('data-brain-stage')).toBe('up_to_date')
    // What the next session gets: the project with the newest memory, the pick, and why none goes now.
    await waitFor(() => expect(m.handoff).toHaveBeenCalledWith('acme-api'))
    const next = await screen.findByRole('list', { name: 'What a new session in acme-api gets' })
    expect(next.textContent).toMatch(/Keep SQLite.*WAL is enough/)
    expect(document.querySelector('[data-brain-gives]')!.textContent).toMatch(/Memory between sessions is off in Settings/)
    expect(document.querySelector('[data-brain-start]')).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: 'View' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))
    const pop = screen.getByRole('dialog', { name: 'Second Brain settings' })
    expect(pop.textContent).toMatch(/Build automatically/)
    // Where it's kept: the path the daemon resolved, as it gave it.
    expect(pop.querySelector('[data-brain-db-path]')!.textContent).toBe('C:\\Users\\me\\AppData\\Roaming\\caprock\\caprock.db')
    expect(pop.textContent).toMatch(/brain_nodes · brain_edges · brain_runs/)
    expect(pop.textContent).toMatch(/nothing goes to Caprock/)
    fireEvent.click(screen.getByRole('radio', { name: 'Sonnet' }))
    await waitFor(() => expect(m.settings).toHaveBeenCalledWith({ model: 'sonnet' }))
    fireEvent.click(screen.getByRole('radio', { name: '1M' }))
    await waitFor(() => expect(m.settings).toHaveBeenCalledWith({ daily_tokens: 1_000_000 }))
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(m.settings).toHaveBeenCalledWith({ auto: false }))
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog', { name: 'Second Brain settings' })).toBeNull()
  })

  it('opens a memory from what the next session gets, and the graph card opens the graph full-screen; Escape closes it', async () => {
    m.status.mockResolvedValue(status({ memories: 2, projects: [{ project: 'web', count: 1 }, { project: 'acme-api', count: 1 }], auto: auto({ stage: 'up_to_date', handoff: { on: true, sessions_24h: 2, memories_24h: 9, sessions: 6, memories: 27 } }) }))
    m.brain.mockResolvedValue({ nodes: [node({ id: 1, source: { project: 'acme-api' }, created_at: 5 }), node({ id: 2, title: 'Use a queue', source: { project: 'web' }, created_at: 9 }), node({ id: 3, kind: 'topic', title: 'queues' })], edges: [], total: 2 })
    m.handoff.mockImplementation(async (p: string) => ({ project: p, memories: [node({ id: p === 'web' ? 2 : 1, title: p === 'web' ? 'Use a queue' : 'Keep SQLite' })], max: 5, budget: 700, served: { on: true, left_off_at: Date.now() - 3_600_000, holdout_pct: 25 } }))
    m.node.mockResolvedValue({ node: node({ id: 2, title: 'Use a queue', summary: 'Retries stay simple.' }), links: [] })
    render(<BrainScreen />)
    // The newest memory's project first.
    await waitFor(() => expect(m.handoff).toHaveBeenCalledWith('web'))
    await screen.findByRole('list', { name: 'What a new session in web gets' })
    expect(document.querySelector('[data-brain-gives]')!.textContent).toBe(
      'A session opening there now gets these, with the passage from 1h ago. 25% of new sessions are held back at random, to measure whether it helps. 2 sessions got 9 memories in the last 24 h, 6 in all.')
    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), { target: { value: 'acme-api' } })
    await screen.findByRole('list', { name: 'What a new session in acme-api gets' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), { target: { value: 'web' } })
    await screen.findByRole('list', { name: 'What a new session in web gets' })
    fireEvent.click(document.querySelector<HTMLElement>('[data-brain-next-row="2"]')!)
    await screen.findByText('Retries stay simple.')
    // The card is a picture and a button, not a graph to work in place.
    const card = await screen.findByRole('button', { name: /Open the graph — 2 memories · 1 topic/ })
    expect(card.querySelector('[data-brain-graph="mini"]')).not.toBeNull()
    expect(document.querySelector('[data-brain-graph="full"]')).toBeNull()
    fireEvent.click(card)
    const dialog = screen.getByRole('dialog', { name: 'Second Brain graph' })
    expect(dialog.querySelector('[data-brain-graph="full"]')).not.toBeNull()
    // The memory opened on the screen is opened beside the graph too.
    expect(dialog.querySelector('[data-brain-detail]')).not.toBeNull()
    // Display controls and the inspector never replace the canvas or lose the selection.
    const canvas = dialog.querySelector('canvas')
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
    expect(dialog.querySelector('[data-brain-detail]')).toBeNull()
    expect(dialog.querySelector('canvas')).toBe(canvas)
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(dialog.querySelector('[data-brain-detail]')).not.toBeNull()
    const display = dialog.querySelector<HTMLDetailsElement>('[data-brain-display]')!
    display.open = true
    const size = screen.getByRole('slider', { name: /Node size/ })
    fireEvent.change(size, { target: { value: '1.5' } })
    expect(size).toHaveValue('1.5')
    expect(dialog.querySelector('canvas')).toBe(canvas)
    fireEvent.click(screen.getByRole('button', { name: 'Reset display' }))
    expect(size).toHaveValue('1')
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog', { name: 'Second Brain graph' })).toBeNull()
    fireEvent.click(card)
    fireEvent.click(screen.getByRole('button', { name: 'Close the graph' }))
    expect(screen.queryByRole('dialog', { name: 'Second Brain graph' })).toBeNull()
  })
})
