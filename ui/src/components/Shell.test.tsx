/**
 * The header's connection state and version chip. Two things it must get right: a source build is
 * not a release and must not be dressed up as one, and an available update is
 * only ever mentioned when the user turned release checks on.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Shell } from './Shell'

const status = vi.hoisted(() => ({ version: 'v0.9.4' }))
const update = vi.hoisted(() => ({ value: undefined as unknown }))
const liveState = vi.hoisted(() => ({
  conn: 'open',
  link: { phase: 'live', attempt: 0, nextAt: null as number | null, downSince: null as number | null },
  lastFrameAt: 0, tick: 0, alerts: [] as unknown[],
}))
const heard = vi.hoisted(() => ({ at: 0 }))

vi.mock('@/lib/live', async (orig) => {
  const actual = await orig<typeof import('@/lib/live')>()
  return { ...actual, useLive: () => liveState, live: { heardAt: () => heard.at } }
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
      // The header's premium chip fetches too. Left unmocked it hit the real
      // client, whose promise could settle after the test had torn the
      // environment down — "window is not defined", intermittently, and only
      // ever on CI. A component added to the shell has to be mocked here even
      // when the test says nothing about it.
      premium: async () => ({
        yearly: { per_month_usd: 2.5, charged_usd: 30, period: 'year', url: 'https://buy/y' },
        monthly: { per_month_usd: 5, charged_usd: 5, period: 'month', url: 'https://buy/m' },
        lifetime: { per_month_usd: 0, charged_usd: 100, period: 'once', url: 'https://buy/l' },
        info_url: 'https://caprock.dev/premium/',
        license: { active: false, in_grace: false },
      }),
    },
  }
})

function renderShell() {
  return render(<Shell route={{ name: 'now' }}>{null}</Shell>)
}

describe('connection state', () => {
  it('says live only while the daemon answers, re-read while nothing arrives', async () => {
    // The dot used to say "live" for as long as the socket object was open.
    // A phone whose network dropped silently kept a socket that looked open,
    // and the header kept saying live over a dead connection. Live now needs
    // something heard in the last 25 s, and the label is re-read every second
    // because on an idle machine no frame arrives to re-render it.
    status.version = 'v0.9.4'
    update.value = undefined
    vi.useFakeTimers()
    try {
      liveState.conn = 'open'
      liveState.link = { phase: 'live', attempt: 0, nextAt: null, downSince: null }
      heard.at = Date.now()
      renderShell()
      await vi.advanceTimersByTimeAsync(0)
      expect(screen.getByText('Live')).toBeTruthy()

      // Pings keep arriving: still live a minute later.
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(10_000)
        heard.at = Date.now()
      }
      expect(screen.getByText('Live')).toBeTruthy()

      // Then silence, with the socket still "open".
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000) })
      expect(screen.queryByText('Live')).toBeNull()
      expect(screen.getByText(/Not answering/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says which try it is on and when the next one is', async () => {
    const now = Date.now()
    liveState.conn = 'closed'
    liveState.link = { phase: 'reconnecting', attempt: 2, nextAt: now + 3_600, downSince: now - 60_000 }
    renderShell()
    expect(await screen.findByText(/^Reconnecting \(3\) · next try in [34] s$/)).toBeTruthy()
  })

  it('says offline, and since when, when the browser has no network', async () => {
    const now = Date.now()
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      liveState.conn = 'closed'
      liveState.link = { phase: 'reconnecting', attempt: 4, nextAt: now + 9_000, downSince: now - 60_000 }
      renderShell()
      expect(await screen.findByText(/^Offline since \d{1,2}:\d{2}/)).toBeTruthy()
    } finally {
      onLine.mockRestore()
    }
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

  it('opens on the way this copy was actually installed', async () => {
    // The chip used to be a label and nothing else: it said a newer version
    // existed and left the user to work out how to get it. The daemon knows
    // the binary's real path and the browser cannot, so when it names a
    // package manager the dialog must open on those steps rather than on
    // whatever is first in the list.
    localStorage.clear()
    status.version = 'v0.9.0'
    update.value = {
      enabled: true,
      current: 'v0.9.0',
      latest: 'v0.9.4',
      update_available: true,
      command: 'brew update && brew upgrade caprock',
    }
    renderShell()
    fireEvent.click(await screen.findByText(/v0\.9\.0 → v0\.9\.4/))
    expect(await screen.findByText('brew update && brew upgrade caprock')).toBeTruthy()
  })

  it('gives every step, not only the one that fetches the new binary', async () => {
    // A new binary on disk is not a new daemon, and the step people skip is
    // the restart — after which they report that updating did nothing.
    localStorage.clear()
    status.version = 'v0.9.0'
    update.value = {
      enabled: true, current: 'v0.9.0', latest: 'v0.9.4', update_available: true,
      command: 'brew update && brew upgrade caprock',
    }
    renderShell()
    fireEvent.click(await screen.findByText(/v0\.9\.0 → v0\.9\.4/))
    expect(await screen.findByText('caprock down && caprock up')).toBeTruthy()
    expect(screen.getByText('caprock status')).toBeTruthy()
  })

  it('lets the reader pick another platform and remembers it', async () => {
    // Someone running Caprock on a Linux box from a Mac browser should not
    // re-pick Linux on every visit.
    localStorage.clear()
    status.version = 'v0.9.4'
    update.value = { enabled: true, current: 'v0.9.4', latest: 'v0.9.4', update_available: false }
    const { unmount } = renderShell()
    fireEvent.click(await screen.findByText('v0.9.4'))
    fireEvent.click(await screen.findByRole('button', { name: 'Windows' }))
    expect(await screen.findByText('scoop update caprock')).toBeTruthy()
    unmount()

    renderShell()
    fireEvent.click(await screen.findByText('v0.9.4'))
    expect(await screen.findByText('scoop update caprock')).toBeTruthy()
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
    // close. Every platform carries a "Downloaded binary" route for exactly
    // this case.
    localStorage.clear()
    status.version = 'v0.9.0'
    update.value = { enabled: true, current: 'v0.9.0', latest: 'v0.9.4', update_available: true }
    renderShell()
    fireEvent.click(await screen.findByText(/v0\.9\.0 → v0\.9\.4/))
    fireEvent.click(await screen.findByRole('button', { name: /downloaded binary/i }))
    expect(await screen.findByText(/open the release page/i)).toBeTruthy()
    expect(screen.getByText('caprock down && caprock up')).toBeTruthy()
  })
})

/**
 * "What's new" beside the version. The release body is remote content — ours,
 * but remote — so it is shown as text, never parsed as markup, and it is
 * never fetched or shown unless release checks are on.
 */
describe("what's new", () => {
  it('shows the release notes and says which version they describe', async () => {
    status.version = 'v0.9.4'
    update.value = {
      enabled: true, current: 'v0.9.4', latest: 'v0.9.4', update_available: false,
      notes: '### Fixed\n- the thing that was broken',
      notes_for: 'v0.9.4',
    }
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: /what's new/i }))
    expect(await screen.findByText(/the thing that was broken/)).toBeTruthy()
    const dialog = screen.getByRole('dialog', { name: /what's new/i })
    expect(dialog.textContent).toMatch(/v0\.9\.4/)
  })

  it('renders the notes as text, never as markup', async () => {
    // Release bodies are written by us and fetched from GitHub. A dialog that
    // renders remote markup is a surface a local-first tool has no reason to
    // open, and the headings read fine as the lines they already are.
    status.version = 'v0.9.4'
    update.value = {
      enabled: true, current: 'v0.9.4', latest: 'v0.9.4', update_available: false,
      notes: '<img src=x onerror=alert(1)>',
      notes_for: 'v0.9.4',
    }
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: /what's new/i }))
    const dialog = await screen.findByRole('dialog', { name: /what's new/i })
    expect(dialog.querySelector('img')).toBeNull()
    expect(dialog.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('offers nothing when there are no notes to show', async () => {
    status.version = 'v0.9.4'
    update.value = { enabled: false, current: 'v0.9.4', update_available: false }
    renderShell()
    await screen.findByText('v0.9.4')
    expect(screen.queryByRole('button', { name: /what's new/i })).toBeNull()
  })
})
