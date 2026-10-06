import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@/lib/api'

const h = vi.hoisted(() => ({ st: undefined as unknown, calls: 0 }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, update: async () => { h.calls++; return h.st } } }
})

import { AppUpdateNotice, upgradeCommands } from './AppUpdateNotice'

const base: UpdateStatus = { enabled: true, current: 'v0.77.0', latest: 'v0.78.0', update_available: true, url: 'https://github.com/dspv/caprock/releases/latest' }

beforeEach(() => {
  localStorage.clear()
  h.calls = 0
})

describe('the app update notice (F12)', () => {
  it('names the cask and the formula commands, app first, and nothing invented', () => {
    expect(upgradeCommands({ ...base, app_command: 'brew update && brew upgrade --cask caprock-app', command: 'brew update && brew upgrade caprock' }))
      .toEqual([
        { label: 'The app', command: 'brew update && brew upgrade --cask caprock-app' },
        { label: 'The daemon', command: 'brew update && brew upgrade caprock' },
      ])
    expect(upgradeCommands({ ...base, command: 'brew update && brew upgrade caprock' })).toEqual([{ label: 'Caprock', command: 'brew update && brew upgrade caprock' }])
    expect(upgradeCommands(base)).toEqual([])
  })

  it('shows quietly, opens to the command, and is dismissed for that version only', async () => {
    h.st = { ...base, app_command: 'brew update && brew upgrade --cask caprock-app' }
    const { unmount } = render(<AppUpdateNotice />)
    const pill = await screen.findByRole('button', { name: 'v0.78.0 is out' })
    fireEvent.click(pill)
    expect(screen.getByText('$ brew update && brew upgrade --cask caprock-app')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText('v0.78.0 is out')).toBeNull()
    expect(localStorage.getItem('caprock.update.dismissed')).toBe('v0.78.0')
    unmount()
    // The next release speaks up again.
    h.st = { ...base, latest: 'v0.79.0' }
    render(<AppUpdateNotice />)
    expect(await screen.findByRole('button', { name: 'v0.79.0 is out' })).toBeTruthy()
  })

  it('says nothing while checks are off or nothing is newer', async () => {
    h.st = { ...base, enabled: false, update_available: false, latest: undefined }
    render(<AppUpdateNotice />)
    await act(async () => { await Promise.resolve() })
    expect(h.calls).toBe(1)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
