/**
 * The dashboard is a tool someone installed for its own sake. The rules that
 * keep a mention of the paid version from turning it into a trial are the
 * point of this component, so they are what is tested.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { PremiumHint } from './PremiumHint'
import { resetPrompts } from '@/lib/prompts'

const NOW = Date.parse('2026-08-26T12:00:00Z')

beforeEach(() => resetPrompts())

describe('PremiumHint', () => {
  it('never quotes a price inside the dashboard', () => {
    render(<PremiumHint reason="this is what a cap stops" now={NOW} />)
    // A figure here turns a screen someone opened to do their work into a
    // storefront. The page it links to does the selling.
    expect(document.body.textContent).not.toMatch(/\$\d/)
  })

  it('stays gone for a month once dismissed', () => {
    const { unmount } = render(<PremiumHint reason="x" now={NOW} />)
    fireEvent.click(screen.getByTitle(/hide this/))
    unmount()

    render(<PremiumHint reason="x" now={NOW + 20 * 24 * 3600 * 1000} />)
    expect(screen.queryByText(/a cap that stops this/)).toBeNull()
  })

  it('comes back after the month, rather than never again', () => {
    const { unmount } = render(<PremiumHint reason="x" now={NOW} />)
    fireEvent.click(screen.getByTitle(/hide this/))
    unmount()

    render(<PremiumHint reason="x" now={NOW + 31 * 24 * 3600 * 1000} />)
    expect(screen.getByText(/a cap that stops this/)).toBeTruthy()
  })
})
