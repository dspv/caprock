/**
 * Now — what a stranger sees in the first five minutes.
 *
 * Three of these pin first-contact defects rather than features:
 *
 *  - Before any session exists the API answers with Go zero values, so the
 *    first screen was a $0.00 hero, three zeroes, and — worst — a *warn*-toned
 *    "Cache hit 0%", because the fault threshold (< 90%) is true of a zero.
 *    The only coloured thing on a new user's first screen was a warning about
 *    a cache that had never been used.
 *  - A model missing from the pricing table leaves cost NULL, which every
 *    aggregate flattened to 0 — tokens of an unpriced model rendered as a
 *    confident "$0.00", indistinguishable from free (rule 6).
 *  - A dead transcript tailer was a log line nobody reads: the daemon looked
 *    healthy while capturing nothing, and this screen told the user to start
 *    `claude` and wait for sessions that could never arrive.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NowScreen } from './Now'
import type { SessionSummary, Status, Summary } from '@/lib/api'

const state = vi.hoisted(() => ({
  status: {} as Partial<Status>,
  summary: undefined as Partial<Summary> | undefined,
  sessions: [] as SessionSummary[],
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => state.status as Status,
      summary: async () => state.summary as Summary,
      sessions: async () => state.sessions,
    },
  }
})

/** A summary as the daemon answers it on a machine that has captured nothing. */
function emptySummary(over: Partial<Summary> = {}): Partial<Summary> {
  return {
    range: 'today', from_ms: 0, sessions: 0, active_sessions: 0, turns: 0, tool_calls: 0,
    tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0,
    models: [], projects: [], pricing_version: '2026-08-01', throttles: 0,
    savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 },
    burn: { window_min: 5, usd_per_hour: 0, tokens_per_min: 0, turns: 0 },
    ...over,
  }
}

afterEach(() => {
  state.status = {}
  state.summary = undefined
  state.sessions = []
  vi.restoreAllMocks()
})

it('shows dashes rather than a wall of zeroes before anything is measured', async () => {
  state.summary = emptySummary()
  state.status = { claude_available: true, hooks: { settings_path: '', shim_path: '', installed: [], missing: [], shim_exists: true } }
  render(<NowScreen />)

  // The hero must not claim a measured $0.00 when nothing has been measured.
  await waitFor(() => expect(screen.getByText('Cost today')).toBeInTheDocument())
  const hero = screen.getByText('Cost today').parentElement!
  expect(hero.textContent).toContain('—')
  expect(hero.textContent).not.toContain('$0.00')
})

it('does not paint a warning onto a cache that has never been used', async () => {
  state.summary = emptySummary()
  state.status = { claude_available: true }
  render(<NowScreen />)

  await waitFor(() => expect(screen.getByText('Cache hit')).toBeInTheDocument())
  const tile = screen.getByText('Cache hit').parentElement!
  // 0% would be < 90% and so warn-toned; with nothing measured there is no
  // number and no fault light.
  expect(tile.textContent).toContain('—')
  expect(tile.querySelector('.text-warn')).toBeNull()
})

it('still shows a real zero once turns exist', async () => {
  // A genuinely free/zero-cost measured range must keep showing $0.00 — the fix
  // is "nothing measured", not "hide zeroes".
  state.summary = emptySummary({ turns: 3, cost_usd: 0 })
  state.status = { claude_available: true }
  render(<NowScreen />)

  await waitFor(() => expect(screen.getByText('Cost today')).toBeInTheDocument())
  expect(screen.getByText('Cost today').parentElement!.textContent).toContain('$0.00')
})

it('says which model it could not price instead of reporting it as free', async () => {
  state.summary = emptySummary({
    turns: 2, cost_usd: 0,
    unpriced: { turns: 2, tokens: 61_000, models: ['claude-opus-9-future'] },
  })
  state.status = { claude_available: true }
  render(<NowScreen />)

  await waitFor(() => expect(screen.getByText(/Cost is incomplete/)).toBeInTheDocument())
  // Naming the model is the actionable half.
  expect(screen.getByText('claude-opus-9-future')).toBeInTheDocument()
  expect(screen.getByText(/not free/)).toBeInTheDocument()
})

it('reports a dead ingest instead of telling the user to wait forever', async () => {
  state.summary = emptySummary()
  state.status = {
    claude_available: true,
    ingest_error: 'mkdir /home/u/.claude: permission denied',
  }
  render(<NowScreen />)

  await waitFor(() => expect(screen.getByText('Ingest stopped')).toBeInTheDocument())
  expect(screen.getByText(/permission denied/)).toBeInTheDocument()
})

it('explains a missing claude binary instead of hiding the control that says so', async () => {
  state.summary = emptySummary()
  state.status = { claude_available: false }
  render(<NowScreen />)

  // The button used to be hidden entirely, which made the dialog that explains
  // why `claude` is missing unreachable.
  const btn = await screen.findByRole('button', { name: /New session/ })
  expect(btn.textContent).toMatch(/claude not found/)
})

it('puts the one control that starts something above the session list', async () => {
  state.summary = emptySummary()
  state.status = { claude_available: true }
  // Needs at least one session, or the grid renders nothing to be above.
  state.sessions = [sess({ session_id: 'a', status: 'active' })]
  const { container } = render(<NowScreen />)

  // A user who had moved onto Caprock as his main surface still could not find
  // this button: it sat at the very bottom in 11px grey, in a row with a
  // checkbox and a "refreshed 3s ago" timestamp. Position is the fix, so
  // position is what is asserted — it must come before the session rows in
  // document order, not merely exist somewhere on the page.
  const btn = await screen.findByRole('button', { name: /New session/ })
  const list = container.querySelector('[data-testid="session-grid"]')
  expect(list, 'session grid did not render').toBeTruthy()
  // Node.compareDocumentPosition: FOLLOWING means the list comes after the button.
  expect(btn.compareDocumentPosition(list!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

/**
 * One busy session and one idle one is the ordinary shape of a working
 * machine, and it used to cost a screen of dead space: each state opened its
 * own three-column grid, so "Active · 1" claimed a row and left two thirds of
 * it empty, then "Idle · 1" did the same below.
 */
function sess(over: Partial<SessionSummary>): SessionSummary {
  return {
    session_id: 'a', project: 'demo', cwd: '/tmp/demo', model: 'claude-opus-5',
    started_at: 0, last_event_at: 0, status: 'active', agent: 'claude',
    activity: { phrase: 'working', tool: '', at: '', health: 'working', repeats: 1 },
    stats: {
      session_id: 'a', turns: 1, tool_calls: 1, files_touched: 0,
      tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 1,
    },
    savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 },
    ...over,
  } as SessionSummary
}

it('puts every session in one grid so a single active card does not reserve a row', async () => {
  state.summary = emptySummary({ sessions: 2 })
  state.status = { claude_available: true }
  state.sessions = [
    sess({ session_id: 'busy' }),
    sess({
      session_id: 'quiet',
      activity: { phrase: 'idle', tool: '', at: '', health: 'idle', repeats: 1 },
    }),
  ]
  render(<NowScreen />)

  const active = await screen.findByText(/Active · 1/)
  const idle = await screen.findByText(/Idle · 1/)

  // The rows must be siblings in one container. A grid per state is what put
  // an "Active · 1" heading on its own row with the next state below it, and
  // it is the thing this rejects — not any particular column count, which has
  // since gone to one on purpose.
  const cardOf = (label: HTMLElement) => label.parentElement!
  const parent = cardOf(active).parentElement!
  expect(cardOf(idle).parentElement).toBe(parent)
  expect(parent.className).toMatch(/\bgrid\b/)
})
