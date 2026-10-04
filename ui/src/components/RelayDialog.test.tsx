/**
 * Continue in… — a new session in any agent, started with a brief the user
 * reads first. The dialog must say it is not the same conversation, show the
 * brief before anything is sent, send what the user edited, and refuse to
 * start where the folder is gone.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayChain, RelayDialog, RelayMenu } from './RelayDialog'
import type { RelayBrief } from '@/lib/api'

const spawn = vi.hoisted(() => vi.fn(async () => ({ session_id: 'new1', cwd: '/w' })))
const brief = vi.hoisted(() => ({
  current: {
    session_id: 'src',
    agent: 'claude',
    cwd: '/w',
    cwd_exists: true,
    passage_at: Date.now() - 3600_000,
    git: { branch: 'feat/x', files: ['modified a.go (+2 -1)'], stat: '1 file changed' },
    prs: [{ number: 7, url: 'https://github.com/o/r/pull/7' }],
    text: 'I am continuing work from an earlier Claude Code session in this folder.\n\n> The retry loop is fixed.',
  } as RelayBrief,
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => ({ claude_available: true, codex_available: true, opencode_available: false, gemini_available: false }),
      relayBrief: async () => brief.current,
      spawn,
    },
  }
})

vi.mock('@/lib/router', async (orig) => ({ ...(await orig<typeof import('@/lib/router')>()), navigate: () => {} }))

describe('RelayDialog', () => {
  beforeEach(() => {
    spawn.mockClear()
    brief.current = { ...brief.current, cwd_exists: true }
  })

  it('says it is a new session with a summary, not the same conversation', async () => {
    render(<RelayDialog sessionID="src" agent="codex" onClose={() => {}} />)
    expect(screen.getByText(/not the same/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Continue in Codex' })).toBeTruthy()
    await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toContain('> The retry loop is fixed.'))
    expect(screen.getByText(/1 changed file on feat\/x/)).toBeTruthy()
    expect(screen.getByText(/1 PR opened/)).toBeTruthy()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('sends what the user edited, as the first message of a relay in the chosen agent', async () => {
    render(<RelayDialog sessionID="src" agent="codex" onClose={() => {}} />)
    const box = await screen.findByRole<HTMLTextAreaElement>('textbox')
    await waitFor(() => expect(box.value).not.toBe(''))
    fireEvent.change(box, { target: { value: 'Only the flaky test is left.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start Codex with this message' }))
    await waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    expect(spawn).toHaveBeenCalledWith({ relay_from: 'src', prompt: 'Only the flaky test is left.', cwd: '/w', agent: 'codex' })
  })

  it('will not start where the folder is gone', async () => {
    brief.current = { ...brief.current, cwd_exists: false }
    render(<RelayDialog sessionID="src" agent="claude" onClose={() => {}} />)
    expect(await screen.findByText(/no longer exists/)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Start Claude Code/ }).disabled).toBe(true)
  })
})

describe('RelayMenu', () => {
  it('offers only the agents this machine can start', async () => {
    render(<RelayMenu sessionID="src" />)
    fireEvent.click(await screen.findByRole('button', { name: /Continue in/ }))
    const items = screen.getAllByRole('menuitem').map((b) => b.textContent)
    expect(items).toEqual(['Claude Code', 'Codex'])
  })
})

describe('RelayChain', () => {
  it('names both ends of a relay', () => {
    render(<RelayChain from={{ session_id: 'aaaaaaaa-1', agent: 'claude', title: 'Fix retries' }} to={[{ session_id: 'bbbbbbbb-2', agent: 'codex' }]} />)
    expect(screen.getByText(/Carries on from a Claude Code session/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Fix retries' }).getAttribute('href')).toBe('#/session/aaaaaaaa-1')
    expect(screen.getByRole('link', { name: 'bbbbbbbb' }).getAttribute('href')).toBe('#/session/bbbbbbbb-2')
  })

  it('is nothing when there is no relay', () => {
    const { container } = render(<RelayChain to={[]} />)
    expect(container.textContent).toBe('')
  })
})
