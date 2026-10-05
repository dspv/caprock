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
      testAlert: async () => {
        tested.n++
        if (tested.fail) throw new Error(tested.fail)
        return { sent: 'ok' }
      },
    },
  }
})

describe('PhoneAlerts', () => {
  it('asks for a bot when there is none, with both switches on', async () => {
    settings.value = { alert_approval: true, alert_finished: true } as Settings
    render(<PhoneAlerts />)
    await waitFor(() => expect(screen.getByText('needs a Telegram bot')).toBeInTheDocument())
    expect(screen.getByPlaceholderText('123456:ABC-DEF…')).toBeInTheDocument()
    expect(screen.getByLabelText(/waiting for approval/)).toBeChecked()
    expect(screen.getByLabelText(/has finished/)).toBeChecked()
    expect(screen.getByLabelText(/last reply's first line/)).toBeChecked()
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
})
