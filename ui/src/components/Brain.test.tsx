import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const m = vi.hoisted(() => ({
  drop: vi.fn(),
  status: vi.fn(),
  brain: vi.fn(),
  node: vi.fn(),
  premium: vi.fn(),
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { ...actual.api, dropBrain: m.drop, brainStatus: m.status, brain: m.brain, brainNode: m.node, premium: m.premium },
  }
})

import { ApiError, type BrainNode } from '@/lib/api'
import { BrainCaptureHost } from './BrainCapture'
import { BrainDropButton } from './BrainDrop'
import { openBrainCapture } from '@/lib/brain'
import { BrainScreen } from '@/screens/brain/BrainScreen'

const node = (over: Partial<BrainNode>): BrainNode => ({
  id: 1, kind: 'decision', title: 'Keep SQLite', summary: '', source: {}, manual: true, pinned: false, created_at: Date.now(), updated_at: Date.now(), ...over,
})
const status = (over = {}) => ({ licensed: true, memories: 1, manual: 1, free_max: 20, free_left: -1, projects: [], ...over })

describe('Second Brain', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
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

  it('says when the free memories are used, and offers Premium', async () => {
    m.status.mockResolvedValue(status({ licensed: false, manual: 20, free_left: 0 }))
    m.premium.mockResolvedValue({ yearly: { url: '', charged_usd: 30 }, lifetime: { url: '', charged_usd: 100 }, info_url: '' })
    m.drop.mockRejectedValue(new ApiError(402, '402', { error: 'premium required' }))
    render(<BrainCaptureHost />)
    act(() => openBrainCapture('one more'))
    await screen.findByText(/0 of 20 free memories left/)
    fireEvent.click(screen.getByRole('button', { name: /Drop it in/ }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toMatch(/free 20 are used/)
    expect(screen.getByRole('button', { name: 'Unlock with Premium' })).toBeTruthy()
  })

  it('drops an answer by its event id and says it is kept', async () => {
    m.drop.mockResolvedValue({ node: node({}), created: true })
    render(<BrainDropButton eventId={42} />)
    fireEvent.click(screen.getByRole('button', { name: 'Drop into brain' }))
    await screen.findByRole('button', { name: 'In your brain' })
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
    const row = await screen.findByRole('button', { name: /Keep SQLite/ })
    expect(row.textContent).toContain('storage')
    // A project is the row's own column, not a topic.
    expect(row.textContent?.match(/caprock/g)?.length).toBe(1)
    fireEvent.click(row)
    await screen.findByText('WAL is enough for one machine.')
    expect(screen.getByRole('link', { name: /the session/ }).getAttribute('href')).toBe('#/session/s1?at=5')
  })
})
