/**
 * The app's notification switches: approval on and finished off until the
 * owner says otherwise, each saved on its own.
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
  it('has approval on and finished off by default, and saves one switch at a time', async () => {
    render(<DesktopNotifications />)
    await waitFor(() => expect(screen.getByText('Desktop notifications')).toBeInTheDocument())
    const approval = screen.getByLabelText(/waiting for approval/)
    const finished = screen.getByLabelText(/has finished/)
    expect(approval).toBeChecked()
    expect(finished).not.toBeChecked()
    fireEvent.click(finished)
    expect(saved.calls).toEqual([{ notify_finished: true }])
    expect(finished).toBeChecked()
  })
})
