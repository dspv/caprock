/**
 * The upgrade banner's warning about running sessions.
 *
 * Upgrading restarts the daemon, and the sessions Caprock started are its
 * children — so they end with it. They get a few seconds to stop cleanly, but
 * the work stops either way, and a user who finds that out afterwards has lost
 * a turn they were in the middle of. The banner has to say so before they copy
 * the command, and only when there is actually something to lose.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UpdateBanner } from './UpdateBanner'
import type { Settings } from '@/lib/api'

const status = vi.hoisted(() => ({
  value: {
    enabled: true,
    current: 'v0.39.0',
    latest: 'v0.40.0',
    update_available: true,
    command: 'brew upgrade caprock',
    url: 'https://example.invalid/releases',
  },
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, update: async () => status.value } }
})

const plan = { update_checks: true } as Settings

describe('UpdateBanner', () => {
  it('warns that spawned sessions will close, before the command', async () => {
    render(<UpdateBanner plan={plan} onSave={() => {}} now={Date.now()} owned={2} />)
    await waitFor(() => expect(screen.getByText(/2 sessions Caprock started will close/)).toBeInTheDocument())
  })

  it('says it in the singular for one session', async () => {
    render(<UpdateBanner plan={plan} onSave={() => {}} now={Date.now()} owned={1} />)
    await waitFor(() => expect(screen.getByText(/1 session Caprock started will close/)).toBeInTheDocument())
  })

  // Sessions the user started themselves survive an upgrade untouched, so a
  // warning with nothing behind it would be noise on every banner.
  it('stays quiet when nothing would be lost', async () => {
    render(<UpdateBanner plan={plan} onSave={() => {}} now={Date.now()} owned={0} />)
    await waitFor(() => expect(screen.getByText(/is available/)).toBeInTheDocument())
    expect(screen.queryByText(/will close/)).not.toBeInTheDocument()
  })
})
