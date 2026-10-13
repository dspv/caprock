/**
 * The Mail offer speaks once: after real use, only while no mail account
 * exists, and opening Mail or dismissing it answers it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MailStrip } from './MailStrip'
import { api } from '@/lib/api'
import { mailApi, type State } from '@/screens/mail/mailApi'
import { resetPrompts } from '@/lib/prompts'
import { resetNudgeSlots } from '@/lib/nudges'

const NOW = Date.parse('2026-10-13T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function given(days: number, accounts: number) {
  vi.spyOn(api, 'history').mockResolvedValue({ totals: { days, sessions: days * 3 } } as unknown as Awaited<ReturnType<typeof api.history>>)
  vi.spyOn(mailApi, 'state').mockResolvedValue({ accounts: Array.from({ length: accounts }, () => ({})), folders: [], counts: { inbox: 0, unread: 0, flagged: 0 }, version: 0 } as unknown as State)
}

const settle = () => new Promise((r) => setTimeout(r, 30))

beforeEach(() => { resetPrompts(); resetNudgeSlots(); vi.restoreAllMocks(); location.hash = '#/' })

describe('MailStrip', () => {
  it('offers Mail after real use and opens it', async () => {
    given(5, 0)
    render(<MailStrip now={NOW} />)
    fireEvent.click(await screen.findByText('Open Mail'))
    expect(location.hash).toBe('#/mail')
  })

  it('says nothing on a first day or to someone who already has an account', async () => {
    given(1, 0)
    const first = render(<MailStrip now={NOW} />)
    await settle()
    expect(first.container.textContent).toBe('')
    first.unmount()
    resetNudgeSlots()
    given(9, 1)
    const set = render(<MailStrip now={NOW} />)
    await settle()
    expect(set.container.textContent).toBe('')
  })

  it('stays away for a month once dismissed', async () => {
    given(5, 0)
    const { unmount } = render(<MailStrip now={NOW} />)
    fireEvent.click(await screen.findByLabelText('Not now'))
    unmount()
    const later = render(<MailStrip now={NOW + 29 * DAY} />)
    await settle()
    expect(later.container.textContent).toBe('')
  })
})
