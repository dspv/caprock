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
import { render, screen, waitFor } from '@testing-library/react'
import { PulsePanel, TIER_TOKEN, IDLE_TOKEN } from './Pulse'
import type { Event, SessionSummary } from '@/lib/api'

/** Seeded events per session id, keyed the way the panel asks for them. */
const seeded = vi.hoisted(() => ({ value: {} as Record<string, Event[]> }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { ...actual.api, recentEvents: async (id: string) => seeded.value[id] ?? [] },
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
    '--color-fg-faint': '#837f78',
  },
  light: {
    '--color-panel': '#ffffff',
    '--color-ok': '#2e9e4f',
    '--color-accent': '#b8730d',
    '--color-accent-strong': '#8f5808',
    '--color-fg-faint': '#8a8479',
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

  it('names which session a track is when more than one is running', async () => {
    seeded.value = { 'aaaaaaaa-1111': [turn('aaaaaaaa-1111', NOW - 60_000)], 'bbbbbbbb-2222': [turn('bbbbbbbb-2222', NOW - 60_000)] }
    render(
      <PulsePanel
        sessions={[
          session({ session_id: 'aaaaaaaa-1111', project: 'caprock', git_branch: 'master' }),
          session({ session_id: 'bbbbbbbb-2222', project: 'caprock', git_branch: 'fix/pulse' }),
        ]}
        now={NOW}
      />,
    )
    // Same project twice: the branch is what tells the two rows apart.
    await waitFor(() => expect(screen.getByText('master')).toBeInTheDocument())
    expect(screen.getByText('fix/pulse')).toBeInTheDocument()
  })

  // The first version of the label above had `shrink-0` on the branch, so a
  // long branch squeezed the project name to nothing and the row read as a
  // branch with no repository — the label erased the identity it was added to
  // clarify. The project is what must survive.
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
    expect(screen.getByText('fix/session-end-and-pulse-tracks').className).toMatch(/\btruncate\b/)
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
