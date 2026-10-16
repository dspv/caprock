import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CleanupLine } from './CleanupLine'
import { cleanupOf, dueText, type CleanupCandidate, type CleanupRecord } from '@/lib/copies'

const m = vi.hoisted(() => ({ cleanup: vi.fn(), cleanUp: vi.fn(), restore: vi.fn() }))
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, cleanup: m.cleanup, cleanUp: m.cleanUp, restoreCopies: m.restore } }
})

const cand = (name: string, size = 700_000_000): CleanupCandidate => ({ path: `/r/.caprock-worktrees/${name}`, branch: name, size, since: Date.now() - 3_600_000 })
const three = [cand('a'), cand('b'), cand('c', 700_000_000)]
const rec = (id: string): CleanupRecord => ({ id, project_id: 7, path: `/r/.caprock-worktrees/${id}`, branch: id, bytes: 1_000_000_000, at: Date.now() - 60_000, how: 'auto', restorable: true })

beforeEach(() => {
  try { localStorage.clear() } catch { /* none */ }
  m.cleanup.mockReset().mockResolvedValue(cleanupOf({ mode: 'ask', candidates: three, total: 2_100_000_000 }))
  m.cleanUp.mockReset()
  m.restore.mockReset()
})

describe('cleanup line', () => {
  it('says how many copies are done and how big, and nothing more', async () => {
    render(<CleanupLine projectId="7" onReview={() => {}} />)
    expect(await screen.findByText('3 copies done')).toBeTruthy()
    expect(screen.getByText('2.1GB')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clean up' })).toBeTruthy()
    expect(screen.queryByText(/removed in/)).toBeNull()
  })

  it('confirms on the same line, then removes exactly those copies', async () => {
    m.cleanUp.mockResolvedValue({ results: three.map((c) => ({ path: c.path, removed: true })), cleanup: cleanupOf({ mode: 'ask', removed: [rec('a'), rec('b'), rec('c')] }) })
    const removed = vi.fn()
    render(<CleanupLine projectId="7" onReview={() => {}} onRemoved={removed} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Clean up' }))
    const confirm = screen.getByRole('group', { name: 'Confirm clean up' })
    expect(confirm.textContent).toMatch(/Remove 3 copies \(2\.1GB\)\?/)
    expect(m.cleanUp).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(m.cleanUp).toHaveBeenCalledWith('7', three.map((c) => c.path)))
    expect(await screen.findByText('Removed 3 copies')).toBeTruthy()
    expect(screen.getByText('3.0GB').parentElement?.textContent).toBe('3.0GB freed')
    expect(removed).toHaveBeenCalledWith(three.map((c) => c.path))
  })

  it('never asks the daemon about a project derived here (a 404 on a fresh page)', async () => {
    const { container } = render(<CleanupLine projectId="dir:/home/me/dev/alpha" onReview={() => {}} />)
    await new Promise((r) => setTimeout(r, 0))
    expect(m.cleanup).not.toHaveBeenCalled()
    expect(container.textContent).toBe('')
  })

  it('Cancel leaves everything', async () => {
    render(<CleanupLine projectId="7" onReview={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Clean up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('3 copies done')).toBeTruthy()
    expect(m.cleanUp).not.toHaveBeenCalled()
  })

  it('Review hands over the finished paths', async () => {
    const review = vi.fn()
    render(<CleanupLine projectId="7" onReview={review} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }))
    expect(review).toHaveBeenCalledWith(three.map((c) => c.path))
  })

  it('in Auto mode says when they go, and Undo restores what went', async () => {
    m.cleanup.mockResolvedValue(cleanupOf({ mode: 'auto', candidates: [{ ...cand('d'), due: Date.now() + 5 * 3_600_000 }], total: 700_000_000, removed: [rec('a'), rec('b')] }))
    m.restore.mockResolvedValue({ results: [{ id: 'a', restored: true }, { id: 'b', restored: true }], cleanup: cleanupOf({ mode: 'auto' }) })
    render(<CleanupLine projectId="7" onReview={() => {}} />)
    expect(await screen.findByText('Removed 2 copies')).toBeTruthy()
    expect(screen.getByText('removed in 5 h')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clean up now' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(m.restore).toHaveBeenCalledWith('7', ['a', 'b']))
    await waitFor(() => expect(screen.queryByText('Removed 2 copies')).toBeNull())
  })

  it('hides the removed line when dismissed', async () => {
    m.cleanup.mockResolvedValue(cleanupOf({ mode: 'auto', removed: [rec('a')] }))
    const { container } = render(<CleanupLine projectId="7" onReview={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Hide this line' }))
    expect(container.querySelector('[data-cleanup-line]')).toBeNull()
  })

  it('says nothing when off or when nothing is finished', async () => {
    m.cleanup.mockResolvedValue(cleanupOf({ mode: 'off', candidates: three }))
    const { container } = render(<CleanupLine projectId="7" onReview={() => {}} />)
    await waitFor(() => expect(m.cleanup).toHaveBeenCalled())
    expect(container.querySelector('[data-cleanup-line]')).toBeNull()
    m.cleanup.mockResolvedValue(cleanupOf({ mode: 'ask' }))
    const two = render(<CleanupLine projectId="8" onReview={() => {}} />)
    await waitFor(() => expect(m.cleanup).toHaveBeenCalledTimes(2))
    expect(two.container.querySelector('[data-cleanup-line]')).toBeNull()
  })
})

describe('dueText', () => {
  it('reads in hours, minutes or soon', () => {
    expect(dueText(10 * 3_600_000, 0)).toBe('in 10 h')
    expect(dueText(40 * 60_000, 0)).toBe('in 40 min')
    expect(dueText(30_000, 0)).toBe('soon')
  })
})
