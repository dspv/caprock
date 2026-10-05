/**
 * "Remove from Caprock": never on a phone, never for a running session, and
 * never in one click — the second click is on a line that names the cost.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoveSession } from './RemoveSession'

const h = vi.hoisted(() => ({
  remove: vi.fn(async (_req: unknown) => ({ dry_run: false, sessions: [{ session_id: 's1' }], skipped: [], cost_usd: 1.5, unmatched_usd: 0 })),
  navigate: vi.fn(),
  paired: false,
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, isPairedDevice: () => h.paired, api: { ...actual.api, removeSessions: h.remove } }
})
vi.mock('@/lib/router', async (orig) => {
  const actual = await orig<typeof import('@/lib/router')>()
  return { ...actual, navigate: h.navigate }
})

beforeEach(() => {
  h.remove.mockClear()
  h.navigate.mockClear()
  h.paired = false
})

describe('RemoveSession', () => {
  it('asks once, names the cost, then removes and leaves the page', async () => {
    render(<RemoveSession sessionID="s1" costUSD={1.5} running={false} />)
    fireEvent.click(screen.getByText('Remove from Caprock'))
    expect(h.remove).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog').textContent).toContain('$1.50')
    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ name: 'now' }))
    expect(h.remove).toHaveBeenCalledWith({ ids: ['s1'] })
  })

  it('is not offered on a paired phone', () => {
    h.paired = true
    const { container } = render(<RemoveSession sessionID="s1" costUSD={1} running={false} />)
    expect(container.textContent).toBe('')
  })

  it('is not offered for a running session', () => {
    const { container } = render(<RemoveSession sessionID="s1" costUSD={1} running />)
    expect(container.textContent).toBe('')
  })

  it('says why when the daemon skipped it', async () => {
    h.remove.mockResolvedValueOnce({ dry_run: false, sessions: [], skipped: [{ session_id: 's1', reason: 'it is still active' } as never], cost_usd: 0, unmatched_usd: 0 })
    render(<RemoveSession sessionID="s1" costUSD={1} running={false} />)
    fireEvent.click(screen.getByText('Remove from Caprock'))
    fireEvent.click(screen.getByText('Remove'))
    expect(await screen.findByText('it is still active')).toBeTruthy()
    expect(h.navigate).not.toHaveBeenCalled()
  })
})
