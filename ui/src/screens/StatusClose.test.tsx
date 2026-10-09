import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, status: () => Promise.reject(new Error('down')) } }
})

import { StatusScreen } from './Status'
import { CloseSettingsContext, escapeLeavesPage } from '@/lib/settingsClose'
import { Sheet } from '@/components/Sheet'

/** Owner, 2026-10-10: Settings had no visible way out but its tab's ×. */
describe('leaving Settings', () => {
  it('closes from the × beside the heading, as the tab does', () => {
    const close = vi.fn()
    render(<CloseSettingsContext.Provider value={close}><StatusScreen /></CloseSettingsContext.Provider>)
    const x = screen.getByRole('button', { name: 'Close settings' })
    expect(x).toHaveAttribute('title', 'Close settings (Esc)')
    fireEvent.click(x)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape, but not from a field or under an open dialog', () => {
    const close = vi.fn()
    const { rerender } = render(
      <CloseSettingsContext.Provider value={close}><StatusScreen /><input aria-label="Licence" /></CloseSettingsContext.Provider>,
    )
    fireEvent.keyDown(screen.getByLabelText('Licence'), { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)

    const sheetClosed = vi.fn()
    rerender(
      <CloseSettingsContext.Provider value={close}>
        <StatusScreen />
        <Sheet label="Over it" onClose={sheetClosed}><p>a dialog</p></Sheet>
      </CloseSettingsContext.Provider>,
    )
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(sheetClosed).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('leaves a typed, composed or handled Escape alone', () => {
    const div = document.createElement('div')
    const area = document.createElement('textarea')
    expect(escapeLeavesPage({ key: 'Escape', defaultPrevented: false, isComposing: false, target: div })).toBe(true)
    expect(escapeLeavesPage({ key: 'Escape', defaultPrevented: false, isComposing: false, target: area })).toBe(false)
    expect(escapeLeavesPage({ key: 'Escape', defaultPrevented: true, isComposing: false, target: div })).toBe(false)
    expect(escapeLeavesPage({ key: 'Escape', defaultPrevented: false, isComposing: true, target: div })).toBe(false)
    expect(escapeLeavesPage({ key: 'a', defaultPrevented: false, isComposing: false, target: div })).toBe(false)
  })
})
