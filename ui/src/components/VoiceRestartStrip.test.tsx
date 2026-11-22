import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

const daemon = vi.hoisted(() => ({
  view: { session_id: 's1', mode: 'acceptEdits', switchable: true, waiting: '' } as Record<string, unknown>,
  restarts: [] as { id: string; mode: string; restart: boolean }[],
  fail: '',
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      permissionMode: async () => ({ ...daemon.view }),
      setPermissionMode: async (id: string, mode: string, restart = false) => {
        if (daemon.fail) throw new Error(daemon.fail)
        daemon.restarts.push({ id, mode, restart })
        return { ...daemon.view }
      },
    },
  }
})

import { POLL_MS, VoiceRestartStrip } from './VoiceRestartStrip'

/** The first read answered: the button can be pressed. */
const ready = () => act(async () => { await vi.advanceTimersByTimeAsync(10) })

describe('the voice restart strip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    daemon.view = { session_id: 's1', mode: 'acceptEdits', switchable: true, waiting: '' }
    daemon.restarts = []
    daemon.fail = ''
  })
  afterEach(() => { vi.useRealTimers() })

  it('says what fixes voice and restarts at once when the agent is idle, in its mode now', async () => {
    const onRestarted = vi.fn()
    render(<VoiceRestartStrip sessionId="s1" onRestarted={onRestarted} onDismiss={() => {}} />)
    await ready()
    expect(screen.getByText('Voice works after restarting this session.')).toBeTruthy()
    const btn = await screen.findByRole('button', { name: 'Restart here' })
    await act(async () => { fireEvent.click(btn) })
    expect(daemon.restarts).toEqual([{ id: 's1', mode: 'acceptEdits', restart: true }])
    expect(onRestarted).toHaveBeenCalledTimes(1)
  })

  it('reads Restart when idle while the agent works, and restarts once its turn is over', async () => {
    daemon.view.waiting = 'turn'
    const onRestarted = vi.fn()
    render(<VoiceRestartStrip sessionId="s1" onRestarted={onRestarted} onDismiss={() => {}} />)
    await ready()
    const btn = await screen.findByRole('button', { name: 'Restart when idle' })
    await act(async () => { fireEvent.click(btn) })
    expect(screen.getByRole('button', { name: 'Restarts when idle' })).toBeTruthy()
    expect(daemon.restarts).toEqual([])
    // Still working at the next read: nothing yet.
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS) })
    expect(daemon.restarts).toEqual([])
    daemon.view.waiting = ''
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS) })
    expect(daemon.restarts).toEqual([{ id: 's1', mode: 'acceptEdits', restart: true }])
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 3) })
    expect(daemon.restarts).toHaveLength(1)
    expect(onRestarted).toHaveBeenCalledTimes(1)
  })

  it('waits while a prompt is on the screen too', async () => {
    daemon.view.waiting = 'permission'
    render(<VoiceRestartStrip sessionId="s1" onRestarted={() => {}} onDismiss={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Restart when idle' })).toBeTruthy()
  })

  it('× dismisses it without restarting', async () => {
    const onDismiss = vi.fn()
    render(<VoiceRestartStrip sessionId="s1" onRestarted={() => {}} onDismiss={onDismiss} />)
    await screen.findByRole('button', { name: 'Restart here' })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss — voice restart' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(daemon.restarts).toEqual([])
  })

  it('says why a restart failed and stays', async () => {
    daemon.fail = 'Could not stop the session to restart it'
    const onRestarted = vi.fn()
    render(<VoiceRestartStrip sessionId="s1" onRestarted={onRestarted} onDismiss={() => {}} />)
    await ready()
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Restart here' })) })
    expect((await screen.findByRole('alert')).textContent).toContain('Could not stop the session')
    expect(onRestarted).not.toHaveBeenCalled()
  })

  it('shows nothing for a session Caprock does not hold (rule 7)', async () => {
    daemon.view = { session_id: 's1', mode: 'default', switchable: false }
    const { container } = render(<VoiceRestartStrip sessionId="s1" onRestarted={() => {}} onDismiss={() => {}} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(container.querySelector('[data-voice-restart]')).toBeNull()
  })
})
