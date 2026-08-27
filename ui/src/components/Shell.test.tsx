/**
 * The header's connection dot and version chip. Two things it must get right: a source build is
 * not a release and must not be dressed up as one, and an available update is
 * only ever mentioned when the user turned release checks on.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Shell } from './Shell'

const status = vi.hoisted(() => ({ version: 'v0.9.4' }))
const update = vi.hoisted(() => ({ value: undefined as unknown }))
const liveState = vi.hoisted(() => ({ conn: 'open', lastFrameAt: 0, tick: 0, alerts: [] as unknown[] }))

vi.mock('@/lib/live', async (orig) => {
  const actual = await orig<typeof import('@/lib/live')>()
  return { ...actual, useLive: () => liveState }
})

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

describe('connection dot', () => {
  it('keeps counting while the machine is idle', async () => {
    // The bug this pins: the label was computed only when a frame arrived, and
    // on an idle machine no frame arrives by definition — so it froze at
    // "live · now" and kept claiming that for hours. A stale liveness
    // indicator is worse than none, because it is trusted.
    status.version = 'v0.9.4'
    update.value = undefined
    vi.useFakeTimers()
    try {
      // A frame that has just landed: the label starts at "now".
      liveState.conn = 'open'
      liveState.lastFrameAt = Date.now()
      renderShell()
      await vi.advanceTimersByTimeAsync(0)
      expect(screen.getByText(/live · now/)).toBeTruthy()

      // Six minutes pass with no further frame — an ordinary idle machine.
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
      expect(screen.queryByText(/live · now/)).toBeNull()
      expect(screen.getByText(/live · \d+m/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says so when the socket is gone', async () => {
    liveState.conn = 'closed'
    liveState.lastFrameAt = Date.now()
    renderShell()
    expect(await screen.findByText(/disconnected/)).toBeTruthy()
  })
})

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

  it('hands over the command for how this copy was installed', async () => {
    // The chip used to be a label and nothing else: it said a newer version
    // existed and left the user to work out how to get it. The owner hit
    // exactly that on a stale build. The command is per-install-method and
    // comes from the daemon, so what matters here is that it reaches the
    // screen at all rather than what it says.
    status.version = 'v0.9.0'
    update.value = {
      enabled: true,
      current: 'v0.9.0',
      latest: 'v0.9.4',
      update_available: true,
      command: 'brew upgrade caprock',
    }
    renderShell()
    const chip = await screen.findByText(/v0\.9\.0 → v0\.9\.4/)
    fireEvent.click(chip)
    expect(await screen.findByText('brew upgrade caprock')).toBeTruthy()
  })

  it('does not pretend it can update itself', async () => {
    // A daemon that overwrites its own running binary is a worse thing to own
    // than a stale version, so the dialog says who does the updating.
    status.version = 'v0.9.0'
    update.value = {
      enabled: true,
      current: 'v0.9.0',
      latest: 'v0.9.4',
      update_available: true,
      command: 'brew upgrade caprock',
    }
    renderShell()
    fireEvent.click(await screen.findByText(/v0\.9\.0 → v0\.9\.4/))
    expect(await screen.findByText(/does not update itself/i)).toBeTruthy()
  })

  it('says where to turn checks on when they are off', async () => {
    status.version = 'v0.9.4'
    update.value = { enabled: false, current: 'v0.9.4', update_available: false }
    renderShell()
    fireEvent.click(await screen.findByText('v0.9.4'))
    expect(await screen.findByText(/release checks are off/i)).toBeTruthy()
  })

  it('never claims a source build is out of date', async () => {
    // A local build is not a published release, so "upgrade" is meaningless.
    status.version = 'dev'
    update.value = { enabled: true, current: 'dev', latest: 'v9.9.9', update_available: true }
    renderShell()
    expect(await screen.findByText('dev build')).toBeTruthy()
    // Matched on the arrow alone before, which caught any arrow anywhere on
    // the screen — including the footer's link to the team page. The claim
    // being tested is that a source build is never offered an upgrade, so
    // match the upgrade offer itself.
    expect(screen.queryByText(/v9\.9\.9/)).toBeNull()
    expect(screen.queryByText(/update available/i)).toBeNull()
  })
})

/**
 * Which screen you are on has to be visible without reading. The state used to
 * be a `bg-panel-2` tint against the header's own `bg-panel` — a few percent of
 * lightness — with the label one step of grey brighter, and on open nobody
 * could tell which tab was current. It is now the filled accent pill the agent
 * filter uses, and these pin that it stays a real difference rather than a
 * shade of one.
 */
describe('header nav', () => {
  it('marks the current screen for a reader and for a screen reader', () => {
    render(<Shell route={{ name: 'cost' }}>{null}</Shell>)
    const current = screen.getByRole('link', { name: 'Cost' })
    expect(current).toHaveAttribute('aria-current', 'page')
    // A filled block, not a tint: the accent background is what carries it.
    expect(current.className).toMatch(/bg-accent/)
  })

  it('leaves the other tabs unmarked and legible', () => {
    render(<Shell route={{ name: 'cost' }}>{null}</Shell>)
    const other = screen.getByRole('link', { name: 'Lifetime' })
    expect(other).not.toHaveAttribute('aria-current')
    expect(other.className).not.toMatch(/bg-accent/)
    // Full-strength text, not the muted grey the whole row used to sit in.
    // `\b` is no good here: it matches inside `text-fg-muted` too, since a
    // hyphen is a word boundary — the assertion passed on the very thing it
    // exists to reject.
    expect(other.className).not.toMatch(/text-fg-(muted|faint|dim)/)
    expect(other.className.split(/\s+/)).toContain('text-fg')
  })

  it('keeps a session under its parent screen', () => {
    render(<Shell route={{ name: 'session', id: 'abc' }}>{null}</Shell>)
    expect(screen.getByRole('link', { name: 'Now' })).toHaveAttribute('aria-current', 'page')
  })
})

describe('the update dialog without a package manager', () => {
  it('still says how to get the new version', async () => {
    // `InstallCommand` returns "" for a downloaded binary or a container
    // rather than guess at a command. The dialog must not then announce a new
    // release and fall silent about what to do — that is the gap it exists to
    // close.
    status.version = 'v0.9.0'
    update.value = { enabled: true, current: 'v0.9.0', latest: 'v0.9.4', update_available: true }
    renderShell()
    fireEvent.click(await screen.findByText(/v0\.9\.0 → v0\.9\.4/))
    expect(await screen.findByText(/not installed by a package manager/i)).toBeTruthy()
    expect(screen.getByText(/release notes/i)).toBeTruthy()
  })
})
