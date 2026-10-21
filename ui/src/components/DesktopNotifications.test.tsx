/**
 * The app's notification switch: everything that needs you, on until the
 * owner says otherwise. A Done turn never notifies, so there is no "has
 * finished" switch (§ Needs you and Done).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DesktopNotifications } from './DesktopNotifications'
import type { Settings } from '@/lib/api'

const saved = vi.hoisted(() => ({ calls: [] as Partial<Settings>[] }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      settings: async () => ({}) as Settings,
      saveSettings: async (s: Settings) => {
        saved.calls.push(s)
        return s
      },
    },
  }
})

describe('DesktopNotifications', () => {
  it('has needs-you on by default, no finished switch, and saves the switch', async () => {
    render(<DesktopNotifications />)
    await waitFor(() => expect(screen.getByText('Desktop notifications')).toBeInTheDocument())
    const needs = screen.getByLabelText(/needs you/)
    expect(needs).toBeChecked()
    expect(screen.queryByLabelText(/has finished/)).toBeNull()
    fireEvent.click(needs)
    expect(saved.calls).toEqual([{ notify_approval: false }])
    expect(needs).not.toBeChecked()
  })
})
