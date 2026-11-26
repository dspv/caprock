import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const daemon = vi.hoisted(() => ({
  name: 'Caprock Terminal',
  opened: [] as { id: string; pane: string }[],
  fail: '',
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      sessionPrivacy: async () => ({ name: daemon.name, live: true }),
      openSessionPrivacy: async (id: string, pane: string) => {
        if (daemon.fail) throw new Error(daemon.fail)
        daemon.opened.push({ id, pane })
        return { name: daemon.name, live: true }
      },
    },
  }
})

import { PrivacyStrip } from './PrivacyStrip'

describe('the folder access strip', () => {
  beforeEach(() => {
    daemon.name = 'Caprock Terminal'
    daemon.opened = []
    daemon.fail = ''
  })

  it('names the folder and the entry, and opens nothing until clicked', async () => {
    render(<PrivacyStrip sessionId="s1" folder="Downloads" onDismiss={() => {}} />)
    await screen.findByText(/Allow Caprock Terminal in System Settings › Privacy & Security › Full Disk Access/)
    expect(screen.getByText(/out of Downloads/)).toBeTruthy()
    expect(daemon.opened).toEqual([])
  })

  it('opens the Full Disk Access pane on the click, then says what to do there', async () => {
    render(<PrivacyStrip sessionId="s1" folder="Downloads" onDismiss={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))
    await waitFor(() => expect(daemon.opened).toEqual([{ id: 's1', pane: 'full_disk' }]))
    await screen.findByText('Switch on Caprock Terminal in the list, then try again.')
  })

  it('shows a failure and dismisses with ×', async () => {
    daemon.fail = 'open failed'
    const onDismiss = vi.fn()
    render(<PrivacyStrip sessionId="s1" folder="Desktop" onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss — folder access' }))
    expect(onDismiss).toHaveBeenCalled()
  })
})
