/**
 * The share sheet: the card itself is on screen before any button is
 * pressed, and the three ways out — copy, save, post to X — each do what
 * their label says.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ShareCard', async (orig) => ({
  ...(await orig<typeof import('./ShareCard')>()),
  drawShareCard: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}))
vi.mock('@/lib/sharecache', () => {
  const data = { period: '7d' }
  return {
    FRESH_MS: 60_000,
    lastFigures: () => undefined,
    lastStory: () => undefined,
    fetchFigures: vi.fn(async () => data),
    currentFigures: vi.fn(async () => data),
    fetchStory: vi.fn(),
    currentStory: vi.fn(),
    warmShare: () => {},
  }
})

import { ShareDialog, xIntent } from './Share'

const write = vi.fn(async () => {})

beforeEach(() => {
  localStorage.setItem('caprock-share-style', 'figures')
  URL.createObjectURL = vi.fn(() => 'blob:card')
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal('ClipboardItem', class { constructor(public items: Record<string, Blob>) {} })
  Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true })
  write.mockClear()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('ShareDialog', () => {
  it('shows the card preview and offers today, the week and all time', async () => {
    render(<ShareDialog onClose={() => {}} />)
    const img = await screen.findByAltText('Your figures, as they will be shared')
    expect(img).toHaveAttribute('src', 'blob:card')
    for (const label of ['today', 'this week', 'all time']) expect(screen.getByRole('button', { name: label })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'this week' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('opens on the period it was asked for', async () => {
    render(<ShareDialog onClose={() => {}} initialPeriod="all" />)
    await screen.findByAltText('Your figures, as they will be shared')
    expect(screen.getByRole('button', { name: 'all time' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('copies the image to the clipboard', async () => {
    render(<ShareDialog onClose={() => {}} />)
    await screen.findByAltText('Your figures, as they will be shared')
    fireEvent.click(screen.getByRole('button', { name: 'Copy image' }))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Copied — paste it anywhere.')).toBeTruthy()
  })

  it('posts to X with words and the site, and the card on the clipboard', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<ShareDialog onClose={() => {}} />)
    await screen.findByAltText('Your figures, as they will be shared')
    fireEvent.click(screen.getByRole('button', { name: 'Post to X' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(open.mock.calls[0]![0]).toBe(xIntent('7d'))
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('puts no figure into the post text — the card carries them with their caveat', () => {
    const url = new URL(xIntent('7d'))
    expect(url.searchParams.get('url')).toBe('https://caprock.dev')
    expect(url.searchParams.get('text')).not.toMatch(/\d/)
  })
})
