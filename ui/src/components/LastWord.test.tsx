/**
 * "What did it ask?" — the panel that saves a trip to the terminal.
 *
 * The decision worth pinning is which line it shows. Roughly a third of
 * sessions end mid-sentence, so the newest assistant text is often "Let me
 * check that…" — showing that as the answer would send the reader to the
 * terminal anyway, which is the trip this exists to save.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LastWord } from './LastWord'
import type { AssistantNote, SessionSummary } from '@/lib/api'

const notes = vi.hoisted(() => ({ value: [] as AssistantNote[] }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, notes: async () => notes.value } }
})

const NOW = Date.parse('2026-08-21T12:00:00Z')

function note(over: Partial<AssistantNote>): AssistantNote {
  return {
    event_id: 1, session_id: 's', project: 'p', ts: NOW - 60_000,
    model: 'claude-opus-5', text: 'text', fragment: false, ...over,
  }
}

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: 's', project: 'caprock', owned: false, last_event_at: NOW,
    activity: { health: 'waiting-on-you', phrase: 'asked you something', at: '' },
    stats: { cost_usd: 1, turns: 1, tool_calls: 1, files_touched: 1 },
    ...over,
  } as unknown as SessionSummary
}

describe('LastWord', () => {
  it('shows what Claude said', async () => {
    notes.value = [note({ text: 'I could not verify the SSO redirect; ask the team.' })]
    render(<LastWord session={session()} now={NOW} onClose={() => {}} />)
    expect(await screen.findByText(/SSO redirect/)).toBeTruthy()
  })

  it('prefers the last complete thought over a newer fragment', async () => {
    // The whole point: "Let me check that" is not an answer, and showing it
    // sends the reader to the terminal anyway.
    notes.value = [
      note({ event_id: 2, text: 'Let me check that', fragment: true }),
      note({ event_id: 1, text: 'The migration needs a backfill first.', fragment: false }),
    ]
    render(<LastWord session={session()} now={NOW} onClose={() => {}} />)
    expect(await screen.findByText(/backfill first/)).toBeTruthy()
    expect(screen.queryByText('Let me check that')).toBeNull()
  })

  it('says so when it had to skip a newer line', async () => {
    notes.value = [
      note({ event_id: 2, text: 'Let me check', fragment: true }),
      note({ event_id: 1, text: 'Done — one thing left.', fragment: false }),
    ]
    render(<LastWord session={session()} now={NOW} onClose={() => {}} />)
    expect(await screen.findByText(/mid-thought/)).toBeTruthy()
  })

  it('falls back to a fragment when there is nothing else', async () => {
    // Better than an empty panel: it is still what the session last said.
    notes.value = [note({ text: 'Working on it…', fragment: true })]
    render(<LastWord session={session()} now={NOW} onClose={() => {}} />)
    expect(await screen.findByText(/Working on it/)).toBeTruthy()
  })

  it('explains an empty session rather than showing a blank panel', async () => {
    notes.value = []
    render(<LastWord session={session()} now={NOW} onClose={() => {}} />)
    expect(await screen.findByText(/has not said anything yet/)).toBeTruthy()
  })

  it('tells you where to reply, which differs by who started the session', async () => {
    // Rule 7: a session Caprock did not spawn cannot be typed into, so the
    // panel says where the answer goes instead of offering a box that fails.
    notes.value = [note({})]
    const { unmount } = render(<LastWord session={session({ owned: false })} now={NOW} onClose={() => {}} />)
    expect(await screen.findByText(/terminal you started it in/)).toBeTruthy()
    unmount()

    render(<LastWord session={session({ owned: true })} now={NOW} onClose={() => {}} />)
    expect(await screen.findByText(/its terminal tab/)).toBeTruthy()
  })

  it('does not break when the notes endpoint fails', async () => {
    notes.value = []
    const boom = vi.spyOn(await import('@/lib/api'), 'api', 'get')
    boom.mockReturnValue({ notes: async () => { throw new Error('daemon gone') } } as never)
    render(<LastWord session={session()} now={NOW} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/daemon gone/)).toBeTruthy())
    boom.mockRestore()
  })
})
