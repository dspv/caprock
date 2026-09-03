import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NotesScreen } from './Notes'

const state = vi.hoisted(() => ({
  memory: { repos: 4, since: '2026-08-20', held: '2026-07-19' } as
    | { repos: number; since?: string; held?: string }
    | undefined,
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      searchNotes: async () => [],
      status: async () => ({ memory: state.memory }),
    },
  }
})

describe('Memory', () => {
  beforeEach(() => {
    state.memory = { repos: 4, since: '2026-08-20', held: '2026-07-19' }
  })

  // Two dates live in the status payload and they mean different things:
  // `since` is as far back as a *handoff* reaches (a fortnight), `held` is when
  // the oldest passage Caprock still has was written. This screen searches all
  // of it, so showing the handoff's date understates the corpus — by a month on
  // the owner's machine. The first version checked one field and formatted the
  // other, which reads as a date either way and is wrong in silence.
  it('dates the corpus, not the fortnight a handoff reaches', async () => {
    render(<NotesScreen />)
    expect(await screen.findByText(/since 19 July|since July 19/)).toBeTruthy()
    expect(screen.queryByText(/August 20|20 August/)).toBeNull()
  })

  it('says nothing about dates when the daemon reports none', async () => {
    state.memory = undefined
    render(<NotesScreen />)
    expect(await screen.findByText(/What Claude has told you\. Local only\./)).toBeTruthy()
  })
})
