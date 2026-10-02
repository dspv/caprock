/**
 * 1-click terminal on a session card: a session Caprock holds and that is
 * still running opens straight in its terminal; a session someone else
 * started never gets the button (rule 7).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/lib/api'

const nav = vi.hoisted(() => vi.fn())
vi.mock('@/lib/router', async (orig) => {
  const actual = await orig<typeof import('@/lib/router')>()
  return { ...actual, navigate: nav }
})

import { SessionCard } from './Now'

function card(over: Partial<SessionSummary>): SessionSummary {
  return {
    session_id: 'abc12345-0000', cwd: '/r', project: 'r', status: 'active', owned: true,
    started_at: Date.now() - 60_000, last_event_at: Date.now(),
    stats: { turns: 1, tool_calls: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0 },
    activity: { health: 'working', phrase: 'responding' },
    savings: {},
    ...over,
  } as unknown as SessionSummary
}

it('opens the terminal of a session Caprock holds', () => {
  render(<SessionCard s={card({})} now={Date.now()} />)
  fireEvent.click(screen.getByTitle('Open its terminal'))
  expect(nav).toHaveBeenCalledWith({ name: 'session', id: 'abc12345-0000', tab: 'terminal' })
})

it('offers no terminal for a session Caprock did not start', () => {
  render(<SessionCard s={card({ owned: false })} now={Date.now()} />)
  expect(screen.queryByTitle('Open its terminal')).toBeNull()
})
