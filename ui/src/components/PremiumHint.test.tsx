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
    const { unmount } = render(<PremiumHint reason="x" now={NOW} canAct />)
    fireEvent.click(screen.getByTitle(/hide this/))
    unmount()

    render(<PremiumHint reason="x" now={NOW + 20 * 24 * 3600 * 1000} canAct />)
    expect(screen.queryByText(/a cap that stops this/)).toBeNull()
  })

  it('comes back after the month, rather than never again', () => {
    const { unmount } = render(<PremiumHint reason="x" now={NOW} canAct />)
    fireEvent.click(screen.getByTitle(/hide this/))
    unmount()

    render(<PremiumHint reason="x" now={NOW + 31 * 24 * 3600 * 1000} canAct />)
    expect(screen.getByText(/a cap that stops this/)).toBeTruthy()
  })

  /**
   * The cap pauses only sessions Caprock started (rule 7). Measured on the
   * owner's database: 122 of the 127 sessions that did real work were started
   * by hand, so "a cap that stops this" was overwhelmingly an offer to stop
   * something the cap cannot reach — the case that prompted this, a loop in a
   * session Caprock had never touched.
   */
  it('does not promise to stop a session the cap cannot touch', () => {
    render(<PremiumHint reason="this is what a cap stops" now={NOW} canAct={false} />)
    expect(screen.queryByText(/a cap that stops this/)).toBeNull()
    expect(screen.queryByText(/this is what a cap stops/)).toBeNull()
    // Still offered — the feature is real, and someone whose sessions Caprock
    // does start is exactly who wants it. Only the claim changes.
    expect(screen.getByText(/what a cap does/)).toBeTruthy()
    expect(screen.getByText(/sessions Caprock starts/)).toBeTruthy()
  })

  it('promises it only where the cap really would have acted', () => {
    render(<PremiumHint reason="this is what a cap stops" now={NOW} canAct />)
    expect(screen.getByText(/a cap that stops this/)).toBeTruthy()
  })

  // Unknown ownership is not ownership. A promise made on a guess is the thing
  // being fixed, so the default has to be the cautious one.
  it('treats unknown ownership as not owned', () => {
    render(<PremiumHint reason="this is what a cap stops" now={NOW} />)
    expect(screen.queryByText(/a cap that stops this/)).toBeNull()
  })
})
