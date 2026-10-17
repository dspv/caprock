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
      telegram: async () => ({ bot_set: true, bot_username: 'my_bot', token_masked: '••••••x9Zq', chat_set: true, chat_name: 'Dima', polling: false }),
    },
  }
})

describe('WeeklyReport', () => {
  it('says which bot is stored without showing its token', async () => {
    settings.value = { report_bot_set: true, report_chat_id: '123' } as Settings
    render(<WeeklyReport />)
    // GET never returns the token, so the panel names the bot and its chat
    // in one line, or an unchanged setup reads as unsaved.
    await waitFor(() => expect(screen.getByText('@my_bot')).toBeInTheDocument())
    expect(screen.getByText(/Connected to/)).toBeInTheDocument()
    expect(screen.getByText('Dima')).toBeInTheDocument()
    expect(screen.queryByText(/x9Zq/)).toBeNull()
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

  it('cannot send an empty token, which would clear a working one', async () => {
    saved.calls = []
    settings.value = { report_bot_set: true, report_chat_id: '123' } as Settings
    render(<WeeklyReport />)
    fireEvent.click(await screen.findByText('Change bot'))
    expect(screen.getByText('Connect')).toBeDisabled()
    expect(saved.calls).toEqual([])
  })

  it('states what the message carries and what it does not', async () => {
    settings.value = {} as Settings
    render(<WeeklyReport />)
    // Someone deciding whether to hand over a bot token is deciding on this.
    await waitFor(() => expect(screen.getByText(/no prompts, no replies, no/i)).toBeInTheDocument())
    expect(screen.getByText(/Nothing passes our server/i)).toBeInTheDocument()
  })
})
