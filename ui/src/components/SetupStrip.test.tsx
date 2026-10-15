/**
 * The setup strip ticks each item from the daemon, has two buttons — Set up
 * (a list of the items) and Later (three days) — retires an item for good on
 * "Not needed", folds to a status-bar chip on ×, and is gone once nothing is
 * left.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SetupChip, SetupStrip, resetSetupChip } from './SetupStrip'
import { api, type PairState, type TelegramStatus } from '@/lib/api'
import { resetPrompts } from '@/lib/prompts'
import { resetNudgeSlots } from '@/lib/nudges'

const NOW = Date.parse('2026-10-10T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function state(phones: number, telegram: boolean) {
  vi.spyOn(api, 'pairState').mockResolvedValue({
    enabled: false,
    devices: Array.from({ length: phones }, (_, i) => ({ id: `d${i}`, name: 'Phone', paired_at: NOW, last_seen: NOW, role: 'viewer' })),
  } as unknown as PairState)
  vi.spyOn(api, 'telegram').mockResolvedValue({ bot_set: telegram, chat_set: telegram, polling: false } as TelegramStatus)
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)))

beforeEach(() => { resetPrompts(); resetNudgeSlots(); resetSetupChip(); vi.restoreAllMocks(); location.hash = '' })

describe('SetupStrip', () => {
  it('has two buttons, and Set up lists both items with their actions', async () => {
    state(0, false)
    render(<SetupStrip now={NOW} />)
    expect(await screen.findByText('Set up')).toBeTruthy()
    expect(screen.getByText('Later')).toBeTruthy()
    expect(screen.queryByText('Connect Telegram')).toBeNull()
    expect(document.body.textContent).toContain('0 of 2')
    fireEvent.click(screen.getByText('Set up'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Open on your phone')).toBeTruthy()
    fireEvent.click(screen.getByText('Connect Telegram'))
    expect(location.hash).toBe('#/settings')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('ticks what is connected and keeps offering the rest', async () => {
    state(1, false)
    render(<SetupStrip now={NOW} />)
    fireEvent.click(await screen.findByText('Set up'))
    expect(screen.getByText(/Phone connected/)).toBeTruthy()
    expect(document.body.textContent).toContain('1 of 2')
    expect(screen.queryByText('Open on your phone')).toBeNull()
    expect(screen.getByText('Connect Telegram')).toBeTruthy()
  })

  it('is gone once both are connected', async () => {
    state(2, true)
    const { container } = render(<SetupStrip now={NOW} />)
    await settle()
    expect(container.textContent).toBe('')
  })

  it('"Not needed" in the list retires one item for good', async () => {
    state(0, false)
    const { rerender } = render(<SetupStrip now={NOW} />)
    fireEvent.click(await screen.findByText('Set up'))
    fireEvent.click(screen.getAllByText('Not needed')[1]!)
    expect(screen.queryByText('Connect Telegram')).toBeNull()
    expect(screen.getByText('Open on your phone')).toBeTruthy()
    rerender(<SetupStrip now={NOW + 365 * DAY} />)
    expect(screen.queryByText('Connect Telegram')).toBeNull()
  })

  it('Later snoozes it for three days', async () => {
    state(0, false)
    const { container, rerender } = render(<SetupStrip now={NOW} />)
    fireEvent.click(await screen.findByText('Later'))
    expect(container.textContent).toBe('')
    rerender(<SetupStrip now={NOW + 2 * DAY} />)
    await settle()
    expect(container.textContent).toBe('')
    rerender(<SetupStrip now={NOW + 3 * DAY + 1} />)
    expect(await screen.findByText('Set up')).toBeTruthy()
  })

  it('× folds it to a chip that unfolds it, and folding is not a dismissal', async () => {
    state(0, false)
    const { container } = render(<><SetupStrip now={NOW} /><footer data-testid="bar"><SetupChip /></footer></>)
    expect(await screen.findByText('Set up')).toBeTruthy()
    expect(screen.getByTestId('bar').textContent).toBe('')
    fireEvent.click(screen.getByLabelText('Fold to the status bar'))
    expect(screen.queryByText('Set up')).toBeNull()
    const chip = container.querySelector('[data-setup-chip]')!
    expect(chip.textContent).toBe('0 of 2')
    // Still folded much later: × is not a snooze that runs out.
    fireEvent.click(chip)
    expect(await screen.findByText('Set up')).toBeTruthy()
    expect(container.querySelector('[data-setup-chip]')).toBeNull()
  })

  it('the chip shows nothing while the strip is unfolded or has nothing left', async () => {
    state(2, true)
    const { container } = render(<><SetupStrip now={NOW} /><SetupChip /></>)
    await settle()
    expect(container.textContent).toBe('')
  })
})
