/**
 * The panel has one job the others do not: making an absence visible. A weekly
 * message that stops arriving looks exactly like a quiet week, so the last
 * outcome has to be on the screen.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WeeklyReport } from './WeeklyReport'
import type { Settings } from '@/lib/api'

const settings = vi.hoisted(() => ({ value: {} as Settings }))
const saved = vi.hoisted(() => ({ calls: [] as Partial<Settings>[] }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      settings: async () => settings.value,
      saveSettings: async (s: Settings) => {
        saved.calls.push(s)
        return s
      },
    },
  }
})

describe('WeeklyReport', () => {
  it('says a token is stored without showing it', async () => {
    settings.value = { report_bot_set: true, report_chat_id: '123' } as Settings
    render(<WeeklyReport />)
    // The field is empty because GET never returns the token — so the panel
    // has to say one exists, or an unchanged setup reads as unsaved.
    await waitFor(() => expect(screen.getByText(/one is stored/)).toBeInTheDocument())
    expect(screen.getByPlaceholderText(/leave blank to keep/)).toHaveValue('')
  })

  // The whole reason the status line exists.
  it('shows why the last send failed, in Telegram’s own words', async () => {
    settings.value = {
      report_bot_set: true, report_chat_id: '1',
      report_last_error: 'chat not found',
    } as Settings
    render(<WeeklyReport />)
    await waitFor(() => expect(screen.getByText(/chat not found/)).toBeInTheDocument())
  })

  it('says nothing has been sent yet rather than leaving it blank', async () => {
    settings.value = { report_bot_set: true, report_chat_id: '1' } as Settings
    render(<WeeklyReport />)
    await waitFor(() => expect(screen.getByText(/Nothing sent yet/)).toBeInTheDocument())
  })

  it('does not send an empty token, which would clear a working one', async () => {
    saved.calls = []
    settings.value = { report_bot_set: true, report_chat_id: '123' } as Settings
    render(<WeeklyReport />)
    // Wait for the chat id to seed from settings, or the button is disabled
    // and the click does nothing.
    await waitFor(() => expect(screen.getByPlaceholderText('123456789')).toHaveValue('123'))
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(saved.calls.length).toBe(1))
    expect(saved.calls[0]).not.toHaveProperty('report_bot_token')
  })

  it('states what the message carries and what it does not', async () => {
    settings.value = {} as Settings
    render(<WeeklyReport />)
    // Someone deciding whether to hand over a bot token is deciding on this.
    await waitFor(() => expect(screen.getByText(/no prompts, no replies, no/i)).toBeInTheDocument())
    expect(screen.getByText(/Nothing passes our server/i)).toBeInTheDocument()
  })
})
