/**
 * The offer has to appear on a rhythm and then stop. A banner that comes back
 * on every page load is one people stop seeing, which costs the offer and the
 * trust in every other banner beside it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SharePrompt } from './SharePrompt'
import { resetPrompts } from '@/lib/prompts'

vi.mock('./ShareCard', () => ({
  ShareCard: ({ period }: { period: string }) => <button>share {period}</button>,
}))

const NOW = Date.parse('2026-08-26T12:00:00Z')

beforeEach(() => resetPrompts())

describe('SharePrompt', () => {
  it('says what the image contains before anyone clicks', () => {
    render(<SharePrompt now={NOW} />)
    // Someone deciding whether to post their own numbers should be told what
    // travels with them, not have to trust that nothing does.
    expect(document.body.textContent).toMatch(/no project names/i)
    expect(document.body.textContent).toMatch(/nothing is uploaded/i)
  })

  it('goes away when dismissed and does not come back next render', () => {
    const { unmount } = render(<SharePrompt now={NOW} />)
    fireEvent.click(screen.getByRole('button', { name: /not now/ }))
    expect(screen.queryByText(/A month of work|A week of work/)).toBeNull()
    unmount()

    // A fresh mount the next day must stay quiet — the answer is remembered,
    // not merely hidden for this render.
    render(<SharePrompt now={NOW + 24 * 3600 * 1000} />)
    expect(screen.queryByText(/A month of work|A week of work/)).toBeNull()
  })

  it('treats taking the card as an answer too', () => {
    const { unmount } = render(<SharePrompt now={NOW} />)
    fireEvent.click(screen.getByRole('button', { name: /share 30d/ }))
    unmount()
    render(<SharePrompt now={NOW + 24 * 3600 * 1000} />)
    expect(screen.queryByText(/A month of work|A week of work/)).toBeNull()
  })
})
