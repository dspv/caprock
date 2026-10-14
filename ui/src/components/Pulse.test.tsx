/**
 * The pulse's colours are the legend's whole claim: three named cost tiers plus
 * an idle hairline. They used to be hardcoded rgba taken from the dark palette,
 * which the light theme flattened — `around it` and `well above it` composited
 * against a white panel to a contrast ratio of 1.05, i.e. the same orange — so
 * the legend explained a distinction a light-theme viewer could not see.
 *
 * These tests pin the two properties that keep that from coming back: every
 * tier resolves through a design token (so each theme supplies its own hue),
 * and the tiers are distinguishable from each other and from the panel in BOTH
 * themes when composited. The contrast arithmetic is done here rather than
 * eyeballed, because "these two oranges look different on my monitor" is
 * exactly the judgement that produced the bug.
 */
import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PulsePanel, TIER_TOKEN, IDLE_TOKEN } from './Pulse'
import type { Event, SessionSummary } from '@/lib/api'

/** Seeded events per session id, keyed the way the panel asks for them. */
const seeded = vi.hoisted(() => ({ value: {} as Record<string, Event[]>, asked: [] as string[], overlap: { window_minutes: 30, sessions: {} } as unknown, overlapAsked: 0 }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      recentEvents: async (id: string) => { seeded.asked.push(id); return seeded.value[id] ?? [] },
      session: async () => ({ repo: { url: 'https://github.com/o/caprock', root: '/r/caprock' } }),
      summary: async () => ({ projects: [{ project: 'caprock', dir: '/r/caprock', tokens: 1_200_000, cost_usd: 42.5, sessions: 3 }] }),
      overlap: async () => { seeded.overlapAsked++; return seeded.overlap },
    },
  }
})

/** The token values from design/tokens.css, per theme. Kept here so the test
 * fails if a theme drops or renames a token the pulse depends on. */
const THEME = {
  dark: {
    '--color-panel': '#211f1d',
    '--color-ok': '#4fbf6b',
    '--color-accent': '#feb157',
    '--color-accent-strong': '#ffcb85',
    '--color-fg-faint': '#8f8b84',
  },
  light: {
    '--color-panel': '#ffffff',
    '--color-ok': '#2e9e4f',
    '--color-accent': '#99600a',
    '--color-accent-strong': '#7a4c06',
    '--color-fg-faint': '#6c675e',
  },
} as const

type Rgb = [number, number, number]

const hex = (h: string): Rgb => {
  const s = h.replace('#', '')
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}

/** Composite a colour drawn at `alpha` over an opaque background. */
const over = (fg: Rgb, alpha: number, bg: Rgb): Rgb =>
  [0, 1, 2].map((i) => fg[i]! * alpha + bg[i]! * (1 - alpha)) as Rgb

/** WCAG relative luminance. */
const luminance = ([r, g, b]: Rgb): number => {
  const f = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** WCAG contrast ratio between two opaque colours. */
const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

const rendered = (theme: keyof typeof THEME, spec: { token: string; alpha: number }): Rgb => {
  const palette = THEME[theme] as Record<string, string>
  const value = palette[spec.token]
  if (!value) throw new Error(`token ${spec.token} is not defined in the ${theme} theme`)
  return over(hex(value), spec.alpha, hex(palette['--color-panel']!))
}

describe('pulse tier colours', () => {
  it('draws every tier from a design token, never a hardcoded colour', () => {
    // A literal rgb()/rgba()/hex in a tier spec is how the light theme broke:
    // a fixed colour cannot follow a theme it was not chosen for.
    for (const [name, spec] of Object.entries({ ...TIER_TOKEN, idle: IDLE_TOKEN })) {
      expect(spec.token, `${name} must name a CSS variable`).toMatch(/^--color-/)
      expect(spec.fallback, `${name} fallback must be a hex literal`).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('gives the three tiers three different tokens', () => {
    const tokens = [TIER_TOKEN.low.token, TIER_TOKEN.mid.token, TIER_TOKEN.high.token]
    expect(new Set(tokens).size, `tiers share a token: ${tokens.join(', ')}`).toBe(3)
  })

  // The regression itself. Before the fix this was 1.05 in the light theme:
  // two tiers the legend names separately, rendered as the same colour.
  it.each(['dark', 'light'] as const)('separates adjacent tiers in the %s theme', (theme) => {
    const low = rendered(theme, TIER_TOKEN.low)
    const mid = rendered(theme, TIER_TOKEN.mid)
    const high = rendered(theme, TIER_TOKEN.high)

    expect(contrast(low, mid), `${theme}: "below median" and "around it" are indistinguishable`)
      .toBeGreaterThan(1.25)
    expect(contrast(mid, high), `${theme}: "around it" and "well above it" are indistinguishable`)
      .toBeGreaterThan(1.25)
    // The extremes must be further apart than either adjacent pair, so the
    // three tiers read as a ramp rather than as three arbitrary colours.
    expect(contrast(low, high)).toBeGreaterThan(contrast(low, mid))
    expect(contrast(low, high)).toBeGreaterThan(contrast(mid, high))
  })

  it.each(['dark', 'light'] as const)('keeps every tier visible against the %s panel', (theme) => {
    const panel = hex(THEME[theme]['--color-panel'])
    for (const [name, spec] of Object.entries(TIER_TOKEN)) {
      expect(contrast(rendered(theme, spec), panel), `${theme}: the ${name} bar is invisible on the panel`)
        .toBeGreaterThan(1.8)
    }
  })

  it.each(['dark', 'light'] as const)('keeps the idle hairline present but quietest in %s', (theme) => {
    const panel = hex(THEME[theme]['--color-panel'])
    const idle = contrast(rendered(theme, IDLE_TOKEN), panel)
    // Visible at all — the old fixed grey sat at 1.13 on a white panel.
    expect(idle, `${theme}: the idle hairline has vanished into the panel`).toBeGreaterThan(1.25)
    // ...but never competing with a real bar, or silence reads as work.
    for (const [name, spec] of Object.entries(TIER_TOKEN)) {
      expect(idle, `${theme}: idle is as loud as the ${name} bar`)
        .toBeLessThan(contrast(rendered(theme, spec), panel))
    }
  })
})

describe('pulse legend', () => {
  // The legend and the canvas must not drift: the idle swatch was once
  // hardcoded at alpha 0.35 while the canvas drew the hairline at 0.16, so the
  // key said one thing and the chart did another. This renders the real panel
  // and reads the real swatches.
  it('paints each swatch from the tier token it names', () => {
    render(<PulsePanel sessions={[session()]} now={Date.now()} />)

    for (const [name, spec] of Object.entries({ ...TIER_TOKEN, idle: IDLE_TOKEN })) {
      const chip = document.querySelector<HTMLElement>(`[data-token="${spec.token}"]`)
      expect(chip, `no legend swatch for the ${name} tier`).not.toBeNull()
      expect(chip!.style.background).toContain(spec.token)
      expect(Number(chip!.style.opacity), `${name} swatch alpha differs from the canvas`)
        .toBeCloseTo(spec.alpha, 5)
    }
  })

  it('still names all three tiers and the idle floor', () => {
    render(<PulsePanel sessions={[session()]} now={Date.now()} />)
    expect(screen.getByText(/below this session's median/)).toBeInTheDocument()
    expect(screen.getByText(/around it/)).toBeInTheDocument()
    expect(screen.getByText(/well above it/)).toBeInTheDocument()
    expect(screen.getByText(/idle/)).toBeInTheDocument()
  })
})

/**
 * Which sessions earn a row.
 *
 * The panel used to draw one track per known session, and a session stayed
 * "known" for twelve hours after it ended. A day in one repository therefore
 * produced six rows all labelled "caprock", most of them an hour of flat
 * hairline — which reads as a broken chart, not as silence.
 */
describe('pulse track selection', () => {
  const NOW = Date.parse('2026-08-21T12:00:00Z')

  it('drops ended sessions and ones that did nothing in the window', async () => {
    seeded.value = {
      live: [turn('live', NOW - 60_000)],
      // Ended, but still inside the window — status is what disqualifies it.
      done: [turn('done', NOW - 60_000)],
      // Live, but its last event predates the hour the panel draws.
      stale: [turn('stale', NOW - 5 * 60 * 60_000)],
    }
    render(
      <PulsePanel
        sessions={[
          session({ session_id: 'live', project: 'alpha' }),
          session({ session_id: 'done', project: 'beta', status: 'ended' }),
          session({ session_id: 'stale', project: 'gamma' }),
        ]}
        now={NOW}
      />,
    )
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument())
    expect(screen.queryByText('beta')).not.toBeInTheDocument()
    expect(screen.queryByText('gamma')).not.toBeInTheDocument()
  })

  it('says the hour was quiet rather than drawing empty tracks', async () => {
    seeded.value = { s: [turn('s', NOW - 5 * 60 * 60_000)] }
    render(<PulsePanel sessions={[session({ session_id: 's' })]} now={NOW} />)
    await waitFor(() => expect(screen.getByText(/Nothing ran in the last/)).toBeInTheDocument())
  })

  // Two true numbers answering different questions used to sit side by side: a
  // session's lifetime cost against an hour of bars, so a long-lived session
  // showed $4,053.39 next to a $101.85 day.
  it('shows what the window cost, not the session lifetime', async () => {
    seeded.value = { s: [turn('s', NOW - 60_000, 0.25)] }
    render(
      <PulsePanel
        sessions={[session({ session_id: 's', stats: { cost_usd: 4053.39 } as SessionSummary['stats'] })]}
        now={NOW}
      />,
    )
    await waitFor(() => expect(screen.getByText('$0.25')).toBeInTheDocument())
    expect(screen.queryByText(/4,053/)).not.toBeInTheDocument()
  })

  // Two rows read "dev/caprock master" and could not be told apart (owner,
  // 2026-10-14): the session's own name leads, in bold; the project, the
  // branch and the short id are the line under it.
  it('names which session a track is when more than one is running', async () => {
    seeded.value = { 'aaaaaaaa-1111': [turn('aaaaaaaa-1111', NOW - 60_000)], 'bbbbbbbb-2222': [turn('bbbbbbbb-2222', NOW - 60_000)] }
    render(
      <PulsePanel
        sessions={[
          session({ session_id: 'aaaaaaaa-1111', project: 'caprock', git_branch: 'master', name: 'Login fix' }),
          session({ session_id: 'bbbbbbbb-2222', project: 'caprock', git_branch: 'master', title: 'Pulse order' }),
        ]}
        now={NOW}
      />,
    )
    const first = await waitFor(() => screen.getByText('Login fix'))
    expect(first.className).toMatch(/font-semibold/)
    expect(screen.getByText('Pulse order')).toBeInTheDocument()
    const under = [...document.querySelectorAll('[data-pulse-key] .mono')].map((n) => n.textContent)
    expect(under[0]).toMatch(/^caprock master · aaaaaaaa/)
    expect(under[1]).toMatch(/^caprock master · bbbbbbbb/)
  })

  // A long name or branch gives way; the row keeps its project.
  it('keeps the project name when the branch is long', async () => {
    seeded.value = { s: [turn('s', NOW - 60_000)] }
    render(
      <PulsePanel
        sessions={[session({ session_id: 's', project: 'caprock', git_branch: 'fix/session-end-and-pulse-tracks' })]}
        now={NOW}
      />,
    )
    const name = await waitFor(() => screen.getByText('caprock'))
    expect(name.className).not.toMatch(/\btruncate\b/)
    expect(name.parentElement!.className).toMatch(/\btruncate\b/)
    expect(name.parentElement!.textContent).toContain('fix/session-end-and-pulse-tracks')
  })
})

/**
 * Where a track sits (owner, 2026-10-14, translated: "the order jumps by
 * activity — not allowed … fixed position, by who was added when … plus let
 * me swap them").
 */
describe('pulse row order', () => {
  const NOW = Date.parse('2026-08-21T12:00:00Z')
  const names = () => [...document.querySelectorAll<HTMLElement>('[data-pulse-key]')].map((n) => n.dataset.pulseKey)
  const three = () => {
    seeded.value = { a: [turn('a', NOW - 60_000)], b: [turn('b', NOW - 60_000)], c: [turn('c', NOW - 60_000)] }
    return [
      session({ session_id: 'b', project: 'two', started_at: 200, last_event_at: NOW - 5000 }),
      session({ session_id: 'a', project: 'one', started_at: 100, last_event_at: NOW - 9000 }),
    ]
  }

  it('keeps the order sessions started in, whatever happens in them, and puts a new one last', async () => {
    localStorage.clear()
    const [b, a] = three()
    const { rerender } = render(<PulsePanel sessions={[b!, a!]} now={NOW} />)
    await waitFor(() => expect(names()).toEqual(['a', 'b']))
    // The older session gets busy: it does not jump.
    rerender(<PulsePanel sessions={[{ ...a!, last_event_at: NOW, activity: { phrase: 'running', health: 'working', at: '' } } as SessionSummary, b!]} now={NOW} />)
    await act(async () => {})
    expect(names()).toEqual(['a', 'b'])
    const c = session({ session_id: 'c', project: 'three', started_at: 300, last_event_at: NOW })
    rerender(<PulsePanel sessions={[c, a!, b!]} now={NOW} />)
    await waitFor(() => expect(names()).toEqual(['a', 'b', 'c']))
  })

  for (const [os, platform, mods] of [
    ['macOS', 'MacIntel', { altKey: true, shiftKey: true }],
    ['Windows', 'Win32', { ctrlKey: true, shiftKey: true }],
    ['Linux', 'Linux x86_64', { ctrlKey: true, shiftKey: true }],
  ] as const) {
    it(`moves a row by keyboard on ${os}, and remembers it`, async () => {
      localStorage.clear()
      const spy = vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
      const [b, a] = three()
      const { unmount } = render(<PulsePanel sessions={[b!, a!]} now={NOW} />)
      await waitFor(() => expect(names()).toEqual(['a', 'b']))
      const toggle = document.querySelector<HTMLElement>('[data-pulse-key="a"] [aria-expanded]')!
      fireEvent.keyDown(toggle, { key: 'ArrowDown', ...mods })
      await waitFor(() => expect(names()).toEqual(['b', 'a']))
      unmount()
      render(<PulsePanel sessions={[b!, a!]} now={NOW} />)
      await waitFor(() => expect(names()).toEqual(['b', 'a']))
      spy.mockRestore()
    })
  }

  it('moves a row dragged onto another, and remembers it', async () => {
    localStorage.clear()
    const [b, a] = three()
    const { unmount } = render(<PulsePanel sessions={[b!, a!]} now={NOW} />)
    await waitFor(() => expect(names()).toEqual(['a', 'b']))
    const rowA = document.querySelector<HTMLElement>('[data-pulse-key="a"]')!
    const rowB = document.querySelector<HTMLElement>('[data-pulse-key="b"]')!
    const from = document.elementFromPoint
    document.elementFromPoint = () => rowB
    fireEvent.pointerDown(rowA.firstElementChild!, { button: 0, clientY: 10 })
    fireEvent.pointerMove(window, { clientY: 40 })
    fireEvent.pointerUp(window, { clientX: 5, clientY: 40 })
    document.elementFromPoint = from
    await waitFor(() => expect(names()).toEqual(['b', 'a']))
    unmount()
    render(<PulsePanel sessions={[b!, a!]} now={NOW} />)
    await waitFor(() => expect(names()).toEqual(['b', 'a']))
  })
})

describe('two sessions in one checkout', () => {
  const NOW = Date.parse('2026-08-21T12:00:00Z')
  const pair = () => {
    seeded.value = { a: [turn('a', NOW - 60_000)], b: [turn('b', NOW - 60_000)] }
    return [
      session({ session_id: 'a', project: 'caprock', cwd: '/r/caprock', repo_root: '/r/caprock', name: 'Login fix', started_at: 100 }),
      session({ session_id: 'b', project: 'caprock', cwd: '/r/caprock', repo_root: '/r/caprock', name: 'Router', started_at: 200 }),
    ]
  }

  it('warns on the files both edited, with the list on hover', async () => {
    localStorage.clear()
    seeded.overlap = {
      window_minutes: 30,
      sessions: {
        a: { checkout: '/r/caprock', with: [{ session_id: 'b', name: 'Router', name_source: 'name', started_at: 200, files: ['/r/caprock/ui/main.ts'] }] },
        b: { checkout: '/r/caprock', with: [{ session_id: 'a', name: 'Login fix', name_source: 'name', started_at: 100, files: ['/r/caprock/ui/main.ts'] }] },
      },
    }
    render(<PulsePanel sessions={pair()} now={NOW} />)
    const chips = await screen.findAllByText('1 file touched by both')
    expect(chips).toHaveLength(2)
    expect(chips[0]!.parentElement!.getAttribute('aria-label')).toMatch(/Router[\s\S]*ui\/main\.ts/)
    // Hovering opens a card naming the neighbour and every file, relative to the checkout.
    fireEvent.mouseEnter(chips[0]!.parentElement!)
    const card = await screen.findByRole('tooltip')
    expect(card).toHaveTextContent(/Edited by this session and Router/)
    expect(card).toHaveTextContent('ui/main.ts')
    fireEvent.mouseLeave(chips[0]!.parentElement!)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Move to a worktree…' })).toHaveLength(2)
  })

  it('names the neighbour quietly when they share only the folder', async () => {
    localStorage.clear()
    seeded.overlap = {
      window_minutes: 30,
      sessions: { a: { checkout: '/r/caprock', with: [{ session_id: 'b', name: 'Router', name_source: 'name', started_at: 200, files: [] }] } },
    }
    render(<PulsePanel sessions={pair()} now={NOW} />)
    const chip = await screen.findByText('shares checkout with Router')
    expect(chip.parentElement!.dataset.overlap).toBe('info')
  })

  it('asks nothing when no two sessions could share a folder', async () => {
    localStorage.clear()
    seeded.overlapAsked = 0
    seeded.value = { a: [turn('a', NOW - 60_000)], b: [turn('b', NOW - 60_000)] }
    render(<PulsePanel sessions={[session({ session_id: 'a', cwd: '/r/one' }), session({ session_id: 'b', cwd: '/r/two' })]} now={NOW} />)
    await waitFor(() => expect(document.querySelectorAll('[data-pulse-key]')).toHaveLength(2))
    expect(seeded.overlapAsked).toBe(0)
  })
})

describe('a pulse row, opened', () => {
  const NOW = Date.parse('2026-08-21T12:00:00Z')

  it('expands in place into the project now, and remembers it', async () => {
    localStorage.clear()
    seeded.value = { a: [turn('a', NOW - 60_000)] }
    const sessions = [
      session({ session_id: 'a', project: 'caprock', cwd: '/r/caprock', live_subagents: 3, model_display: 'Opus 5.5', activity: { phrase: 'running go test', health: 'working', at: '' } }),
      session({ session_id: 'b', project: 'caprock', cwd: '/r/caprock/ui', agent: 'codex', activity: { phrase: 'editing Pulse.tsx', health: 'idle', at: '' } }),
    ]
    const { unmount } = render(<PulsePanel sessions={sessions} now={NOW} />)
    await waitFor(() => expect(screen.getByText('caprock')).toBeInTheDocument())
    // Who is working, at reading size: words, not a faint ×4.
    expect(screen.getByText('4 agents')).toBeInTheDocument()
    expect(screen.queryByText('Open session')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /what is running in/i })[0]!)
    expect(await screen.findByText(/\$42\.50 · 1\.20M tokens · 3 sessions/)).toBeInTheDocument()
    expect(screen.getByText('editing Pulse.tsx')).toBeInTheDocument()
    expect(screen.getByText('Open session')).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'Open repo ↗' })).toBeInTheDocument()
    unmount()
    render(<PulsePanel sessions={sessions} now={NOW} />)
    await waitFor(() => expect(screen.getByText('Open session')).toBeInTheDocument())
  })
})

describe('seeding the tracks', () => {
  // Sorted by the newest event, two busy sessions swap places every few
  // seconds; keyed on that order, each swap read 2,000 events per track again.
  it('reads a track once, not again when the order changes, and a new one on its own', async () => {
    const NOW = Date.now()
    seeded.value = { a: [turn('a', NOW - 60_000)], b: [turn('b', NOW - 60_000)] }
    seeded.asked = []
    const a = session({ session_id: 'a', project: 'one', last_event_at: NOW - 1000 })
    const b = session({ session_id: 'b', project: 'two', last_event_at: NOW - 2000 })
    const { rerender } = render(<PulsePanel sessions={[a, b]} now={NOW} />)
    await waitFor(() => expect(seeded.asked.sort()).toEqual(['a', 'b']))
    rerender(<PulsePanel sessions={[{ ...b, last_event_at: NOW }, a]} now={NOW} />)
    await act(async () => {})
    expect(seeded.asked).toHaveLength(2)
    const c = session({ session_id: 'c', project: 'three', last_event_at: NOW })
    rerender(<PulsePanel sessions={[c, b, a]} now={NOW} />)
    await waitFor(() => expect(seeded.asked).toHaveLength(3))
    expect(seeded.asked[2]).toBe('c')
    expect(screen.getByText('one')).toBeInTheDocument()
  })
})

/** One assistant turn, which is what buildPulse counts as a minute of work. */
function turn(sessionID: string, ts: number, cost = 0.01): Event {
  return {
    id: ts,
    ts: new Date(ts).toISOString(),
    session_id: sessionID,
    source: 'hook',
    kind: 'turn.assistant',
    payload: {},
    cost_usd: cost,
  } as Event
}

/** The least session that makes PulsePanel render — it returns null with none. */
function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: 's-1',
    project: 'demo',
    status: 'active',
    last_event_at: Date.now(),
    ...over,
  } as SessionSummary
}
