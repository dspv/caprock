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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NowScreen } from './Now'
import type { SessionSummary, Status, Summary } from '@/lib/api'

const state = vi.hoisted(() => ({
  status: {} as Partial<Status>,
  summary: undefined as Partial<Summary> | undefined,
  sessions: [] as SessionSummary[],
  /** What the server holds, when it is more than it sent. */
  sessionTotal: undefined as number | undefined,
  spawned: [] as unknown[],
  /** Every (activeOnly, search, limit) the screen asked the list for. */
  listCalls: [] as unknown[][],
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
      // The screen asks for the list with its total, so the cap can be stated
      // rather than hidden; the mock answers in the same shape.
      sessionsWithTotal: async (...args: unknown[]) => {
        state.listCalls.push(args)
        return { items: state.sessions, total: state.sessionTotal ?? state.sessions.length }
      },
      session: async (id: string) => {
        const s = state.sessions.find((x) => x.session_id === id)
        if (!s) throw new Error('not found')
        return { ...s, files: [], events: [] }
      },
      spawn: async (req: unknown) => { state.spawned.push(req); return { session_id: 'chat-1', cwd: '/data/chats/x' } },
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

  await waitFor(() => expect(screen.getByText('Partial cost')).toBeInTheDocument())
  // Naming the model is the actionable half.
  expect(screen.getByText('claude-opus-9-future')).toBeInTheDocument()
  expect(screen.getByText(/tokens not priced/)).toBeInTheDocument()
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

it('starts a chat without asking where it should live', async () => {
  state.summary = emptySummary()
  state.status = { claude_available: true }
  state.spawned = []
  render(<NowScreen />)

  // Asking a question is not working on a repository, and demanding an
  // absolute path before answering one is a wall. The request must carry no
  // cwd at all — Caprock picks the directory — or this is just the old dialog
  // with a different label.
  const btn = await screen.findByRole('button', { name: /Quick chat/ })
  fireEvent.click(btn)
  await waitFor(() => expect(state.spawned).toHaveLength(1))
  const req = state.spawned[0] as { chat?: boolean; cwd?: string }
  expect(req.chat).toBe(true)
  expect(req.cwd).toBeUndefined()
})

it('offers no chat button when claude is missing', async () => {
  state.summary = emptySummary()
  state.status = { claude_available: false }
  render(<NowScreen />)

  // Unlike New session, this button carries no explanation of its own — it
  // spawns immediately — so showing it without a working binary would just
  // produce an error where a question was asked.
  await screen.findByRole('button', { name: /New session/ })
  expect(screen.queryByRole('button', { name: /Quick chat/ })).toBeNull()
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

it('says when the ended list is only part of what there is', async () => {
  // The list is capped at 200 server-side. Labelling the array it received —
  // "Ended · 200" — states a count of the page as though it were a count of
  // every ended session, directly below a lifetime strip saying otherwise.
  // Nothing on the screen said the list had been cut.
  state.summary = emptySummary({ sessions: 431 })
  state.status = { claude_available: true }
  state.sessions = [
    sess({ session_id: 'e1', status: 'ended', activity: { phrase: 'done', tool: '', at: '', health: 'idle', repeats: 1 } }),
    sess({ session_id: 'e2', status: 'ended', activity: { phrase: 'done', tool: '', at: '', health: 'idle', repeats: 1 } }),
  ]
  state.sessionTotal = 431
  render(<NowScreen />)

  const show = await screen.findByLabelText(/show ended sessions/i)
  fireEvent.click(show)

  expect(await screen.findByText(/Ended · 2 of 431/)).toBeTruthy()
})

it('states a plain count when the server sent everything it had', async () => {
  state.summary = emptySummary({ sessions: 2 })
  state.status = { claude_available: true }
  state.sessions = [
    sess({ session_id: 'e1', status: 'ended', activity: { phrase: 'done', tool: '', at: '', health: 'idle', repeats: 1 } }),
    sess({ session_id: 'e2', status: 'ended', activity: { phrase: 'done', tool: '', at: '', health: 'idle', repeats: 1 } }),
  ]
  state.sessionTotal = 2
  render(<NowScreen />)

  fireEvent.click(await screen.findByLabelText(/show ended sessions/i))
  expect(await screen.findByText(/Ended · 2$/)).toBeTruthy()
})

// FB-035/036: an ended card says when it ended — not "waiting for you" — and
// whether it can go on, without a trip to the detail screen.
it('shows an ended card as ended, with continue or the reason it cannot', async () => {
  state.summary = emptySummary({ sessions: 2 })
  state.status = { claude_available: true }
  state.sessions = [
    sess({ session_id: 'ok1', status: 'ended', last_event_at: Date.now() - 3_600_000, resume: { ok: true, command: 'claude --resume ok1' },
      activity: { phrase: 'waiting for you', tool: '', at: '', health: 'idle', repeats: 1 } }),
    sess({ session_id: 'gone', status: 'ended', last_event_at: Date.now() - 3_600_000, resume: { ok: false, reason: 'Claude Code has deleted its transcript' },
      activity: { phrase: 'waiting for you', tool: '', at: '', health: 'idle', repeats: 1 } }),
  ]
  render(<NowScreen />)
  fireEvent.click(await screen.findByLabelText(/show ended sessions/i))

  const button = await screen.findByRole('button', { name: 'continue' })
  expect(screen.queryByText('waiting for you')).toBeNull()
  expect(screen.getByText('can’t continue').getAttribute('title')).toMatch(/deleted/)
  fireEvent.click(button)
  await waitFor(() => expect(state.spawned).toContainEqual(expect.objectContaining({ resume: 'ok1', fork: false })))
})

// After Vova's machine restarted, four ended cards all read "ended 29 Sep
// 18:26": the shutdown closed them at one minute and the card showed that.
// The card says when the session was worked in (FB-037).
it('dates an ended card by when it was worked in, not when it was closed', async () => {
  state.summary = emptySummary({ sessions: 1 })
  state.status = { claude_available: true }
  const worked = new Date(2026, 8, 29, 16, 40).getTime()
  const restart = new Date(2026, 8, 29, 18, 26).getTime()
  state.sessions = [
    sess({ session_id: 'w1', status: 'ended', started_at: new Date(2026, 8, 29, 14, 2).getTime(),
      worked_at: worked, last_event_at: restart,
      activity: { phrase: 'done', tool: '', at: '', health: 'idle', repeats: 1 } }),
  ]
  render(<NowScreen />)
  fireEvent.click(await screen.findByLabelText(/show ended sessions/i))
  const span = await screen.findByText(/14:02–16:40/)
  expect(span.textContent).not.toMatch(/18:26/)
  expect(span.getAttribute('title')).toMatch(/ended .*18:26/)
})

it('folds a /clear chain into one card that links the earlier part', async () => {
  state.summary = emptySummary({ sessions: 2 })
  state.status = { claude_available: true }
  state.sessions = [
    sess({ session_id: 'head', status: 'ended', description: 'after the clear', parent_session: 'tail',
      activity: { phrase: 'done', tool: '', at: '', health: 'idle', repeats: 1 } }),
    sess({ session_id: 'tail', status: 'ended', description: 'before the clear',
      activity: { phrase: 'done', tool: '', at: '', health: 'idle', repeats: 1 } }),
  ]
  render(<NowScreen />)
  fireEvent.click(await screen.findByLabelText(/show ended sessions/i))
  await screen.findByText(/continues an earlier session/)
  const earlier = screen.getByRole('button', { name: 'before the clear' })
  expect(earlier).toBeTruthy()
  fireEvent.click(earlier)
  expect(location.hash).toMatch(/tail/)
})

it('searches ended sessions on the server and pages past the first 200', async () => {
  state.summary = emptySummary({ sessions: 450 })
  state.status = { claude_available: true }
  state.sessions = [sess({ session_id: 'e1', status: 'ended', activity: { phrase: 'done', tool: '', at: '', health: 'idle', repeats: 1 } })]
  state.sessionTotal = 450
  state.listCalls = []
  render(<NowScreen />)
  fireEvent.click(await screen.findByLabelText(/show ended sessions/i))

  fireEvent.click(await screen.findByRole('button', { name: /show 200 more/ }))
  await waitFor(() => expect(state.listCalls).toContainEqual([false, '', 400]))

  fireEvent.change(screen.getByPlaceholderText(/find a session/), { target: { value: ' bigquery ' } })
  // Debounced, trimmed, and back to the first page for a new question.
  await waitFor(() => expect(state.listCalls).toContainEqual([false, 'bigquery', 200]))
})

it('names the sessions a restart cut off, each with continue, until dismissed', async () => {
  localStorage.clear()
  const stopped = Date.now() - 3600_000
  state.summary = emptySummary({ sessions: 2 })
  state.status = { claude_available: true, interrupted: { stopped_at: stopped, ids: ['cut', 'gone'] } }
  const ended = { status: 'ended' as const, resume: { ok: true, command: 'claude --resume cut' },
    activity: { phrase: 'done', tool: '', at: '', health: 'idle' as const, repeats: 1 } }
  state.sessions = [
    sess({ session_id: 'cut', project: 'sxope', description: 'Spanner queries', ...ended }),
  ]
  const { unmount } = render(<NowScreen />)
  // One of the two ids no longer exists; the banner counts what it can show.
  await screen.findByText(/A session was still running when Caprock last stopped/)
  expect(screen.getByText(/Spanner queries/)).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'continue' }).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: 'dismiss' }))
  expect(screen.queryByText(/still running when Caprock last stopped/)).toBeNull()
  unmount()
  // Dismissed for this stop, on the next visit too.
  render(<NowScreen />)
  await screen.findByText(/Spanner queries/, undefined, { timeout: 200 }).catch(() => null)
  expect(screen.queryByText(/still running when Caprock last stopped/)).toBeNull()
})
