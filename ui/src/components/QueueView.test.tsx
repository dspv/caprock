/**
 * The Queue view: the order it lists things in, that every estimate is a
 * labelled rough range (or a stated reason there is none), and that Add to
 * queue only ever offers sessions Caprock started and sends to the one picked.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardSession, QueueBoard, QueueSendResult } from '@/lib/api'
import { fmtRange, fmtSpan, freeLabel, itemEta, ordinal, pickFree, positionLabel, changesBoard } from '@/lib/queueboard'
import { QueueView } from './QueueView'

const NOW = 1_760_000_000_000

const state = vi.hoisted(() => ({
  board: undefined as unknown as QueueBoard,
  sent: [] as [string, string][],
  canControl: true,
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      queueBoard: async () => state.board,
      queueSend: async (id: string, text: string): Promise<QueueSendResult> => {
        state.sent.push([id, text])
        return { sent: false, queue: { session_id: id, messages: [{ id: 9, session_id: id, text, created_at: 0, updated_at: 0 }], waiting: 'turn' } }
      },
    },
  }
})
vi.mock('@/lib/useCanControl', () => ({ useCanControl: () => state.canControl }))

const est = { turns: 18, p25_ms: 60_000, median_ms: 180_000, p75_ms: 420_000 }

function sess(over: Partial<BoardSession>): BoardSession {
  return { session_id: 's', agent: 'claude', project: 'caprock', dir: '/r', waiting: '', queue: [], ...over }
}

function board(): QueueBoard {
  return {
    now: NOW,
    done_since: NOW - 3 * 3_600_000,
    sessions: [
      sess({
        session_id: 'busy', title: 'Fix the cache test', waiting: 'turn', turn_started_at: NOW - 120_000,
        todo: { active: 'Running the tests', done: 3, total: 7 },
        turn_left: { lo_ms: 0, mid_ms: 60_000, hi_ms: 300_000 },
        free_in: { lo_ms: 120_000, mid_ms: 420_000, hi_ms: 1_140_000 },
        estimate: est,
        queue: [
          { id: 1, session_id: 'busy', text: 'then write the docs', created_at: 0, updated_at: 0, position: 1,
            start: { lo_ms: 0, mid_ms: 60_000, hi_ms: 300_000 }, finish: { lo_ms: 60_000, mid_ms: 240_000, hi_ms: 720_000 } },
          { id: 2, session_id: 'busy', text: 'and open a PR', created_at: 0, updated_at: 0, position: 2,
            start: { lo_ms: 60_000, mid_ms: 240_000, hi_ms: 720_000 }, finish: { lo_ms: 120_000, mid_ms: 420_000, hi_ms: 1_140_000 } },
        ],
      }),
      sess({ session_id: 'idle', title: 'Spare hand', waiting: '', free_in: { lo_ms: 0, mid_ms: 0, hi_ms: 0 }, estimate: est }),
      sess({ session_id: 'new', title: 'Elsewhere', project: 'site', dir: '/site', estimate_note: '2 turns finished in this project so far; an estimate needs 5' }),
    ],
    done: [
      { session_id: 'busy', agent: 'claude', title: 'Fix the cache test', prompt: 'read the failing test', started_at: NOW - 600_000, ended_at: NOW - 300_000, queued: true },
    ],
  }
}

afterEach(() => {
  state.sent = []
  state.canControl = true
})

describe('queueboard helpers', () => {
  it('formats ranges, never a bare point', () => {
    expect(fmtRange(30_000, 50_000)).toBe('under a minute')
    expect(fmtRange(60_000, 540_000)).toBe('1–9 min')
    expect(fmtRange(-5, 90_000)).toBe('0–2 min')
    expect(fmtRange(2 * 3_600_000, 5 * 3_600_000)).toBe('2–5 h')
    expect(itemEta({ lo_ms: 0, mid_ms: 0, hi_ms: 0 }, { lo_ms: 60_000, mid_ms: 120_000, hi_ms: 300_000 }, 0)).toBe('starts any moment · done in 1–5 min')
    expect(itemEta(undefined, undefined, 0)).toBe('')
    expect(fmtSpan(48_000)).toBe('48 s')
    expect(fmtSpan(4_500_000)).toBe('1 h 15 min')
    expect(freeLabel({ lo_ms: 0, mid_ms: 0, hi_ms: 0 })).toBe('free now')
    expect(freeLabel({ lo_ms: 0, mid_ms: 5_000, hi_ms: 50_000 })).toBe('free in under a minute')
    expect(freeLabel({ lo_ms: 60_000, mid_ms: 200_000, hi_ms: 540_000 })).toBe('free in about 1–9 min')
  })
  it('says where a message stands', () => {
    expect(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st'].join()).toBe([1, 2, 3, 4, 11, 12, 13, 21].map(ordinal).join())
    expect(positionLabel(1, true)).toBe('next, after the current turn')
    expect(positionLabel(2, true)).toBe('2nd after the current turn')
    expect(positionLabel(1, false)).toBe('next')
  })
  it('picks the session free soonest, never one waiting on you or another project', () => {
    const b = board()
    expect(pickFree(b.sessions, '/r')?.session_id).toBe('idle')
    const asking = b.sessions.map((s) => (s.session_id === 'idle' ? { ...s, waiting: 'permission' as const } : s))
    expect(pickFree(asking, '/r')?.session_id).toBe('busy')
    // No estimates at all: an idle Claude Code session, then the shortest queue.
    expect(pickFree(b.sessions, '/site')?.session_id).toBe('new')
    expect(pickFree(b.sessions, '/nowhere')).toBeUndefined()
  })
  it('refreshes only on frames that can change the board', () => {
    expect(changesBoard({ type: 'event', data: { kind: 'agent.stop' } } as never)).toBe(true)
    expect(changesBoard({ type: 'event', data: { kind: 'tool.pre', tool: 'TodoWrite' } } as never)).toBe(true)
    expect(changesBoard({ type: 'event', data: { kind: 'tool.pre', tool: 'Bash' } } as never)).toBe(false)
    expect(changesBoard({ type: 'queue', data: {} } as never)).toBe(true)
    expect(changesBoard({ type: 'session', data: { session: { status: 'active' } } } as never)).toBe(false)
  })
})

describe('QueueView', () => {
  it('lists working sessions first, the queue in order, and labels every estimate', async () => {
    state.board = board()
    render(<QueueView />)
    const now = await screen.findByRole('region', { name: 'Now' })
    const rows = within(now).getAllByRole('listitem')
    expect(rows.map((r) => r.getAttribute('data-now-row'))).toEqual(['busy', 'idle', 'new'])
    expect(rows[0]!.textContent).toContain('Running the tests · 3 of 7 done')
    expect(rows[0]!.textContent).toContain('this turn has run 2 min')
    expect(rows[0]!.textContent).toContain('0–5 min left')
    expect(rows[0]!.textContent).toContain('rough estimate: middle half of the last 18 turns in caprock (1 min–7 min, typical 3 min)')
    // Too few turns: the count, not a number.
    expect(rows[2]!.textContent).toContain('No estimate: 2 turns finished in this project so far; an estimate needs 5.')

    const waiting = screen.getByRole('region', { name: 'Waiting' })
    const items = within(waiting).getAllByRole('listitem')
    expect(items.map((i) => i.getAttribute('data-queued-item'))).toEqual(['1', '2'])
    expect(items[0]!.textContent).toContain('next, after the current turn')
    expect(items[0]!.textContent).toContain('starts in 0–5 min · done in 1–12 min (rough)')
    expect(items[1]!.textContent).toContain('2nd after the current turn')

    const done = screen.getByRole('region', { name: 'Done' })
    expect(done.textContent).toContain('read the failing test')
    expect(done.textContent).toContain('from the queue')
  })

  it('adds to the session that is free first, and only offers sessions Caprock started', async () => {
    state.board = board()
    render(<QueueView />)
    const target = await screen.findByLabelText('Session')
    const options = within(target).getAllByRole('option').map((o) => o.getAttribute('value'))
    // The board holds only owned sessions; the picker offers those of the project and "free first".
    expect(options).toEqual(['__free__', 'busy', 'idle'])
    expect(screen.getByText(/→ Spare hand/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'run the linter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(state.sent).toEqual([['idle', 'run the linter']]))

    fireEvent.change(target, { target: { value: 'busy' } })
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'after that' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(state.sent[1]).toEqual(['busy', 'after that']))
    expect(await screen.findByRole('status')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '/site' } })
    expect(within(screen.getByLabelText('Session')).getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual(['__free__', 'new'])
  })

  it('a viewer without control sees the queue but no Add', async () => {
    state.canControl = false
    state.board = board()
    render(<QueueView />)
    await screen.findByRole('region', { name: 'Now' })
    expect(screen.queryByRole('region', { name: 'Add to queue' })).toBeNull()
  })

  it('says so when no agent Caprock started is running', async () => {
    state.board = { now: NOW, done_since: NOW, sessions: [], done: [] }
    render(<QueueView />)
    expect(await screen.findByText('No agents Caprock started are running')).toBeTruthy()
  })
})
