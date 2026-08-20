/**
 * The header's version chip. Two things it must get right: a source build is
 * not a release and must not be dressed up as one, and an available update is
 * only ever mentioned when the user turned release checks on.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Shell } from './Shell'

const status = vi.hoisted(() => ({ version: 'v0.9.4' }))
const update = vi.hoisted(() => ({ value: undefined as unknown }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => status,
      update: async () => update.value,
      settings: async () => ({ update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0 }),
    },
  }
})

function renderShell() {
  return render(<Shell route={{ name: 'now' }}>{null}</Shell>)
}

describe('version chip', () => {
  it('shows the running release', async () => {
    status.version = 'v0.9.4'
    update.value = undefined
    renderShell()
    expect(await screen.findByText('v0.9.4')).toBeTruthy()
  })

  it('calls a source build what it is rather than showing a git string', async () => {
    status.version = 'v0.9.4-3-ga2d0776-dirty'
    update.value = undefined
    renderShell()
    expect(await screen.findByText('dev build')).toBeTruthy()
    expect(screen.queryByText(/ga2d0776/)).toBeNull()
  })

  it('points at a newer release when one exists', async () => {
    status.version = 'v0.9.0'
    update.value = { enabled: true, current: 'v0.9.0', latest: 'v0.9.4', update_available: true }
    renderShell()
    await waitFor(() => expect(screen.getByText(/v0\.9\.0 → v0\.9\.4/)).toBeTruthy())
  })

  it('never claims a source build is out of date', async () => {
    // A local build is not a published release, so "upgrade" is meaningless.
    status.version = 'dev'
    update.value = { enabled: true, current: 'dev', latest: 'v9.9.9', update_available: true }
    renderShell()
    expect(await screen.findByText('dev build')).toBeTruthy()
    expect(screen.queryByText(/→/)).toBeNull()
  })
})
