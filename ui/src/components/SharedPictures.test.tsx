/**
 * Settings → Privacy lists the cards uploaded to caprock.dev, each with
 * Remove, and draws nothing when there are none.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '@/lib/api'
import { SharedPictures } from './SharedPictures'

beforeEach(() => { vi.restoreAllMocks() })

describe('SharedPictures', () => {
  it('draws nothing when no card was shared', async () => {
    const list = vi.spyOn(api, 'sharedCards').mockResolvedValue({ items: [] })
    const { container } = render(<SharedPictures />)
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('removes a card and says the site may keep its preview', async () => {
    vi.spyOn(api, 'sharedCards').mockResolvedValue({ items: [
      { id: 'a1', url: 'https://caprock.dev/c/a1', bytes: 3, at: Date.now() - 60_000 },
      { id: 'b2', url: 'https://caprock.dev/c/b2', bytes: 3, at: Date.now() - 120_000 },
    ] })
    const remove = vi.spyOn(api, 'removeSharedCard').mockResolvedValue({ removed: true })
    render(<SharedPictures />)
    expect(await screen.findByText('caprock.dev/c/a1')).toBeTruthy()
    expect(screen.getByText(/may keep the preview it already fetched/)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!)
    await waitFor(() => expect(screen.queryByText('caprock.dev/c/a1')).toBeNull())
    expect(remove).toHaveBeenCalledWith('a1')
    expect(screen.getByText('caprock.dev/c/b2')).toBeTruthy()
  })

  it('keeps the card and says why when the site could not remove it', async () => {
    vi.spyOn(api, 'sharedCards').mockResolvedValue({ items: [{ id: 'a1', url: 'https://caprock.dev/c/a1', bytes: 3, at: 1 }] })
    vi.spyOn(api, 'removeSharedCard').mockRejectedValue(new ApiError(502, '502', { error: 'could not reach caprock.dev' }))
    render(<SharedPictures />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('Could not remove it: could not reach caprock.dev')).toBeTruthy()
    expect(screen.getByText('caprock.dev/c/a1')).toBeTruthy()
  })
})
