/**
 * The team offer appears only when a second person commits to the same code,
 * leads with this machine's figure, quotes no price, and dismissal is a month
 * of silence. The dialog behind it must not call the team version anything
 * but the product (rule 11).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamsBanner } from './TeamsBanner'
import { api } from '@/lib/api'
import { resetPrompts } from '@/lib/prompts'
import { resetNudgeSlots } from '@/lib/nudges'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const FACT = { costUSD: 2471.94, projects: 6, window: 'in the last 30 days' }
const DAY = 24 * 60 * 60 * 1000

function team(authors: number) {
  vi.spyOn(api, 'teamSignal').mockResolvedValue({ authors, repos: 3, window_days: 30, checked_ms: NOW })
}

beforeEach(() => { resetPrompts(); resetNudgeSlots(); vi.restoreAllMocks() })

describe('TeamsBanner', () => {
  it('leads with this machine, links to the team page and quotes no price', async () => {
    team(3)
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<TeamsBanner fact={FACT} now={NOW} />)
    expect(await screen.findByText('$2,471.94')).toBeTruthy()
    expect(document.body.textContent).toMatch(/Your team runs agents too\. 3 people committed/)
    expect((document.body.textContent ?? '').replace('$2,471.94', '')).not.toMatch(/\$\d/)
    expect(document.body.textContent).not.toMatch(/pilot|coming soon|not built|beta/i)
    fireEvent.click(screen.getByText('Caprock for Teams →'))
    expect(open).toHaveBeenCalledWith('https://caprock.dev/teams/?ref=app', '_blank', 'noopener')
  })

  it('says nothing to someone who commits alone', async () => {
    team(1)
    const { container } = render(<TeamsBanner fact={FACT} now={NOW} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.textContent).toBe('')
  })

  it('says nothing before anything has been measured', async () => {
    team(3)
    const { container } = render(<TeamsBanner fact={{ ...FACT, costUSD: 0 }} now={NOW} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.textContent).toBe('')
  })

  it('stays away for a month once dismissed', async () => {
    team(3)
    const { unmount } = render(<TeamsBanner fact={FACT} now={NOW} />)
    fireEvent.click(await screen.findByText('not now'))
    unmount()
    const later = render(<TeamsBanner fact={FACT} now={NOW + 29 * DAY} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(later.container.textContent).toBe('')
    later.unmount()
    render(<TeamsBanner fact={FACT} now={NOW + 31 * DAY} />)
    expect(await screen.findByText('not now')).toBeTruthy()
  })

  it('opens what teams get, starting from the same figure', async () => {
    team(2)
    render(<TeamsBanner fact={FACT} now={NOW} />)
    fireEvent.click(await screen.findByText('what teams get'))
    const dialog = screen.getByRole('dialog', { name: 'Caprock for Teams' })
    expect(dialog.textContent).toMatch(/On this machine alone: \$2,471\.94 across 6 projects/)
    expect(screen.getByRole('link', { name: 'Book a demo' })).toHaveAttribute('href', 'https://caprock.dev/book/')
    expect(dialog.textContent).not.toMatch(/pilot|coming soon|not built|beta/i)
    // Dollar figures other than the reader's own may appear only inside the
    // picture, and the picture must say it is an example (rule 6).
    const picture = dialog.querySelector('figure[role="img"]')!
    expect(picture.textContent).toMatch(/Example team/)
    expect(picture.getAttribute('aria-label')).toMatch(/Illustrative/)
    const outside = (dialog.textContent ?? '').replace(picture.textContent ?? '', '').replace('$2,471.94', '')
    expect(outside).not.toMatch(/\$\d/)
  })
})
