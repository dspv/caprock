/**
 * The Morning summary's row: off by default, 08:00 until chosen, says what
 * goes to Telegram, saves its own switch and time, and sends a test.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MorningSummary, validAt } from './MorningSummary'
import type { Settings } from '@/lib/api'

const tested = vi.hoisted(() => ({ n: 0, fail: '' }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      testMorning: async () => {
        tested.n++
        if (tested.fail) throw new Error(tested.fail)
        return { sent: 'ok' }
      },
    },
  }
})

describe('MorningSummary', () => {
  it('is off at 08:00 until chosen, and says what goes to Telegram', () => {
    render(<MorningSummary s={{} as Settings} now={Date.now()} save={() => {}} />)
    const box = screen.getByRole('checkbox', { name: /Morning summary/ }) as HTMLInputElement
    expect(box.checked).toBe(false)
    const time = screen.getByLabelText('Morning summary time') as HTMLInputElement
    expect(time.value).toBe('08:00')
    expect(time.disabled).toBe(true)
    expect(screen.getByText(/the sender’s name and subject of mail Caprock Mail marked important/)).toBeInTheDocument()
    expect(screen.getByText(/Never a mail’s body/)).toBeInTheDocument()
  })

  it('saves the switch and a valid time', () => {
    const saves: Partial<Settings>[] = []
    const { rerender } = render(<MorningSummary s={{} as Settings} now={Date.now()} save={(p) => saves.push(p)} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Morning summary/ }))
    expect(saves).toEqual([{ morning_summary: true }])
    rerender(<MorningSummary s={{ morning_summary: true } as Settings} now={Date.now()} save={(p) => saves.push(p)} />)
    fireEvent.change(screen.getByLabelText('Morning summary time'), { target: { value: '07:30' } })
    expect(saves[1]).toEqual({ morning_summary_at: '07:30' })
  })

  it('sends a test and shows Telegram’s answer when it fails', async () => {
    render(<MorningSummary s={{ morning_summary: true } as Settings} now={Date.now()} save={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send a test summary now' }))
    expect(await screen.findByText('sent — check Telegram')).toBeInTheDocument()
    tested.fail = 'telegram: chat not found'
    fireEvent.click(screen.getByRole('button', { name: 'Send a test summary now' }))
    await waitFor(() => expect(screen.getByText('telegram: chat not found')).toBeInTheDocument())
    expect(tested.n).toBe(2)
  })

  it('accepts only HH:MM', () => {
    expect(validAt('08:00')).toBe(true)
    expect(validAt('23:59')).toBe(true)
    expect(validAt('24:00')).toBe(false)
    expect(validAt('8:00')).toBe(false)
    expect(validAt('')).toBe(false)
  })
})
