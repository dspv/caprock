/**
 * Phone alerts are free and share the weekly report's bot, so the bot is set
 * up here too; the switches say what they do and save on their own.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PhoneAlerts } from './PhoneAlerts'
import type { Settings } from '@/lib/api'

const settings = vi.hoisted(() => ({ value: {} as Settings }))
const saved = vi.hoisted(() => ({ calls: [] as Partial<Settings>[] }))
const tested = vi.hoisted(() => ({ n: 0, fail: '' }))
const tg = vi.hoisted(() => ({ status: { bot_set: false, chat_set: false, polling: false } as Record<string, unknown>, saved: 0 }))

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
      telegram: async () => tg.status,
      telegramToken: async () => {
        tg.saved++
        return tg.status
      },
      testAlert: async () => {
        tested.n++
        if (tested.fail) throw new Error(tested.fail)
        return { sent: 'ok' }
      },
    },
  }
})

describe('PhoneAlerts', () => {
  it('says plainly what to do when Telegram refuses the bot token: the setup card again, with the paste field', async () => {
    settings.value = { report_bot_set: true, report_chat_id: '42', alert_approval: true, alert_last_error: 'telegram: Unauthorized' } as Settings
    render(<PhoneAlerts />)
    expect(await screen.findByText("Telegram no longer accepts this bot's token")).toBeInTheDocument()
    expect(screen.getByRole('alert').textContent).toMatch(/API Token/)
    expect(screen.getByRole('button', { name: 'Open @BotFather' })).toBeInTheDocument()
    expect(screen.getByLabelText('Bot token')).toBeInTheDocument()
    // Not a second copy of Telegram's words under the card.
    expect(screen.queryByText(/Last alert failed/)).toBeNull()
  })

  it('leads with the three setup steps when there is no bot, and holds the switches until there is', async () => {
    settings.value = { alert_approval: true, alert_finished: true } as Settings
    render(<PhoneAlerts />)
    await waitFor(() => expect(screen.getByText('needs a Telegram bot')).toBeInTheDocument())
    expect(await screen.findByPlaceholderText('Paste the bot token')).toBeInTheDocument()
    expect(screen.getByText('Connect your Telegram bot')).toBeInTheDocument()
    expect(screen.getByText('Paste it here')).toBeInTheDocument()
    expect(screen.getByText('The code shows here once the token is in.')).toBeInTheDocument()
    expect(screen.getByText('Open @BotFather')).toBeInTheDocument()
    expect(screen.queryByLabelText(/waiting for approval/)).toBeNull()
    expect(screen.queryByText('Send a test alert')).toBeNull()
  })

  it('saves one switch alone', async () => {
    saved.calls = []
    settings.value = { report_bot_set: true, report_chat_id: '1', alert_approval: true, alert_finished: true } as Settings
    render(<PhoneAlerts />)
    const box = await screen.findByLabelText(/has finished/)
    fireEvent.click(box)
    expect(saved.calls).toEqual([{ alert_finished: false }])
    expect(box).not.toBeChecked()
  })

  it('turns the reply line off on its own', async () => {
    saved.calls = []
    settings.value = { report_bot_set: true, report_chat_id: '1' } as Settings
    render(<PhoneAlerts />)
    const box = await screen.findByLabelText(/last reply's first line/)
    expect(box).toBeChecked()
    fireEvent.click(box)
    expect(saved.calls).toEqual([{ alert_reply: false }])
    expect(box).not.toBeChecked()
  })

  it('sends a test alert and shows Telegram’s refusal', async () => {
    tested.fail = 'telegram: chat not found'
    settings.value = { report_bot_set: true, report_chat_id: '1' } as Settings
    render(<PhoneAlerts />)
    fireEvent.click(await screen.findByText('Send a test alert'))
    await waitFor(() => expect(screen.getByText(/chat not found/)).toBeInTheDocument())
    expect(tested.n).toBe(1)
  })

  it('says a newly saved bot is untested instead of a failure that was the old bot’s', async () => {
    settings.value = { report_bot_set: true, report_chat_id: '1', alert_approval: true, alert_untested: true } as Settings
    render(<PhoneAlerts />)
    expect(await screen.findByText('Saved. Send a test alert to check it reaches you.')).toBeInTheDocument()
    expect(screen.queryByText(/Last alert failed/)).toBeNull()
  })

  it('clears a failed test’s words when a new token is saved', async () => {
    tested.fail = 'telegram: Forbidden: bot was blocked by the user'
    tg.status = { bot_set: true, bot_username: 'newbot', chat_set: true, chat_name: 'Me', polling: true }
    settings.value = { report_bot_set: true, report_chat_id: '1', alert_approval: true } as Settings
    render(<PhoneAlerts />)
    fireEvent.click(await screen.findByText('Send a test alert'))
    await waitFor(() => expect(screen.getByText(/bot was blocked/)).toBeInTheDocument())
    // The daemon forgot its outcome on save; the screen forgets its own.
    settings.value = { ...settings.value, alert_untested: true }
    fireEvent.click(await screen.findByRole('button', { name: 'Change bot' }))
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: '123456:abcdefghijklmnopqrstuvwxyz0123456789' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(tg.saved).toBe(1))
    await waitFor(() => expect(screen.queryByText(/bot was blocked/)).toBeNull())
    expect(await screen.findByText('Saved. Send a test alert to check it reaches you.')).toBeInTheDocument()
    tested.fail = ''
  })

  it('says plainly that an idle bot is not read', async () => {
    tg.status = { bot_set: false, chat_set: false, polling: false }
    settings.value = { report_bot_set: true, report_chat_id: '1' } as Settings
    render(<PhoneAlerts />)
    expect(await screen.findByText(/connected but idle: with no alert on, nothing is sent and Caprock does not read/)).toBeInTheDocument()
  })
})
