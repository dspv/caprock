import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const m = vi.hoisted(() => ({
  node: vi.fn(),
  unlink: vi.fn((): Promise<void> => Promise.resolve()),
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, brainNode: m.node, unlinkBrain: m.unlink } }
})

import type { BrainNode } from '@/lib/api'
import { BrainDetail } from './BrainDetail'

const node = (over: Partial<BrainNode>): BrainNode => ({
  id: 1, kind: 'decision', title: 'Five dollars a month', summary: '', source: {}, manual: false, pinned: false, created_at: Date.now(), updated_at: Date.now(), ...over,
})

describe('a memory, opened', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('says a superseded decision is no longer current, and undoes the supersede alone', async () => {
    const newer = node({ id: 2, title: 'Thirty dollars a year' })
    m.node.mockResolvedValue({
      node: node({ superseded_by: 2, keywords: ['price', 'premium'] }),
      links: [{ node: newer, kind: 'supersedes', out: false, weight: 1 }, { node: newer, kind: 'relates', out: false, weight: 1 }],
    })
    render(<BrainDetail id={1} onSelect={() => {}} onClose={() => {}} editable />)
    await waitFor(() => expect(screen.getByText(/no longer current/)).toBeTruthy())
    expect(screen.getByText('price, premium')).toBeTruthy()
    expect(screen.getByText('replaced by')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Not replaced: Thirty dollars a year' }))
    // From the newer to this one, that kind only: the relates link stays.
    await waitFor(() => expect(m.unlink).toHaveBeenCalledWith(2, 1, 'supersedes'))
    expect(m.unlink).toHaveBeenCalledTimes(1)
  })
})
