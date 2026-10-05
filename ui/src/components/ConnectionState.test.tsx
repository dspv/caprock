/**
 * The honest state indicator (WP-13): never "Live" without a round trip in
 * the last 25 s, and every other state says what is being done about it.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionState } from './ConnectionState'
import type { LinkStatus } from '@/lib/reconnect'

const link = (over: Partial<LinkStatus>): LinkStatus => ({ phase: 'live', attempt: 0, nextAt: null, downSince: null, ...over })

describe('ConnectionState', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

  it('stops saying Live 25 s after the last thing heard, with no event to re-render it', () => {
    vi.useFakeTimers()
    const heard = Date.now()
    render(<ConnectionState link={link({})} heardAt={() => heard} />)
    expect(screen.getByRole('status').textContent).toBe('Live')
    act(() => { vi.advanceTimersByTime(23_000) })
    expect(screen.getByRole('status').textContent).toBe('Live')
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByRole('status').textContent).not.toMatch(/Live/)
  })

  it('counts down to the next try', () => {
    vi.useFakeTimers()
    const now = Date.now()
    render(<ConnectionState link={link({ phase: 'reconnecting', attempt: 3, nextAt: now + 5_000, downSince: now - 1_000 })} heardAt={() => 0} />)
    expect(screen.getByRole('status').textContent).toBe('Reconnecting (4) · next try in 5 s')
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(screen.getByRole('status').textContent).toBe('Reconnecting (4) · next try in 2 s')
  })

  it('says a try is under way while it is', () => {
    render(<ConnectionState link={link({ phase: 'reconnecting', attempt: 4, nextAt: null, downSince: Date.now() })} heardAt={() => 0} />)
    expect(screen.getByRole('status').textContent).toBe('Reconnecting (4) · trying now')
  })

  it('says catching up, ended, and revoked with the reason', () => {
    const { rerender } = render(<ConnectionState link={link({ phase: 'catching-up' })} heardAt={() => Date.now()} />)
    expect(screen.getByRole('status').textContent).toBe('Catching up…')
    rerender(<ConnectionState link={link({ phase: 'ended' })} heardAt={() => 0} />)
    expect(screen.getByRole('status').textContent).toBe('Session ended')
    rerender(<ConnectionState link={link({ phase: 'revoked', reason: 'ask on the machine Caprock runs on' })} heardAt={() => 0} />)
    expect(screen.getByRole('status').textContent).toBe('Control revoked — ask on the machine Caprock runs on')
  })

  it('says offline since when when the browser has no network', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const down = new Date(2026, 9, 6, 14, 5).getTime()
    render(<ConnectionState link={link({ phase: 'reconnecting', attempt: 2, nextAt: Date.now() + 4_000, downSince: down })} heardAt={() => 0} />)
    expect(screen.getByRole('status').textContent).toMatch(/^Offline since 0?2:05|^Offline since 14:05/)
  })
})
