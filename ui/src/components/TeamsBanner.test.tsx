/**
 * The team offer follows the same rules as the Premium banner: the reader's
 * own number first, no price, nothing on an empty dashboard, and dismissal is
 * a month of silence. And the dialog behind it must not call the team version
 * anything but the product (rule 11).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { TeamsBanner } from './TeamsBanner'
import { resetPrompts } from '@/lib/prompts'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const FACT = { costUSD: 2471.94, projects: 6, window: 'in the last 30 days' }

beforeEach(() => resetPrompts())

describe('TeamsBanner', () => {
  it('leads with this machine and quotes no price', () => {
    render(<TeamsBanner fact={FACT} now={NOW} />)
    expect(screen.getByText('$2,471.94')).toBeTruthy()
    expect(document.body.textContent).toMatch(/6 projects in the last 30 days, on this machine/)
    expect((document.body.textContent ?? '').replace('$2,471.94', '')).not.toMatch(/\$\d/)
  })

  it('says nothing before anything has been measured', () => {
    const { container } = render(<TeamsBanner fact={{ ...FACT, costUSD: 0 }} now={NOW} />)
    expect(container.textContent).toBe('')
  })

  it('stays away for a month once dismissed', () => {
    const { unmount } = render(<TeamsBanner fact={FACT} now={NOW} />)
    fireEvent.click(screen.getByText('not now'))
    unmount()
    const day = 24 * 60 * 60 * 1000
    const later = render(<TeamsBanner fact={FACT} now={NOW + 29 * day} />)
    expect(later.container.textContent).toBe('')
    later.unmount()
    const back = render(<TeamsBanner fact={FACT} now={NOW + 31 * day} />)
    expect(back.container.textContent).not.toBe('')
  })

  it('opens what teams get, starting from the same figure', () => {
    render(<TeamsBanner fact={FACT} now={NOW} />)
    fireEvent.click(screen.getByText('what teams get'))
    const dialog = screen.getByRole('dialog', { name: 'Caprock for Teams' })
    expect(dialog.textContent).toMatch(/On this machine alone: \$2,471\.94 across 6 projects/)
    expect(screen.getByRole('link', { name: 'Book a demo' })).toHaveAttribute('href', 'https://caprock.dev/book/')
    expect(dialog.textContent).not.toMatch(/pilot|coming soon|not built|beta/i)
    // Dollar figures other than the reader's own may appear only inside the
    // picture, and the picture must say it is an example (rule 6). No price
    // figure anywhere: the pricing page owns it.
    const picture = dialog.querySelector('figure[role="img"]')!
    expect(picture.textContent).toMatch(/Example team/)
    expect(picture.getAttribute('aria-label')).toMatch(/Illustrative/)
    const outside = (dialog.textContent ?? '').replace(picture.textContent ?? '', '').replace('$2,471.94', '')
    expect(outside).not.toMatch(/\$\d/)
  })
})
