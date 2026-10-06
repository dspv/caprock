/**
 * The status strip's version follows the daemon, not the page: read again on
 * every reconnect of the live link and on window focus.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDaemonVersion } from './useDaemonVersion'

const h = vi.hoisted(() => ({
  conn: 'connecting' as 'connecting' | 'open' | 'closed',
  subs: new Set<() => void>(),
  status: vi.fn(),
}))

vi.mock('./api', () => ({ api: { status: h.status } }))
vi.mock('./live', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useLive: () => ({
      conn: useSyncExternalStore(
        (l: () => void) => { h.subs.add(l); return () => { h.subs.delete(l) } },
        () => h.conn,
      ),
    }),
  }
})

const setConn = (c: typeof h.conn) => act(() => { h.conn = c; for (const l of h.subs) l() })

beforeEach(() => {
  h.conn = 'connecting'
  h.subs.clear()
  h.status.mockReset()
})

describe('the daemon version', () => {
  it('is read at mount and again when the link reconnects to a swapped daemon', async () => {
    h.status.mockResolvedValue({ version: '0.78.0' })
    const { result } = renderHook(() => useDaemonVersion())
    await waitFor(() => expect(result.current).toBe('0.78.0'))
    setConn('open')
    await waitFor(() => expect(h.status).toHaveBeenCalledTimes(2))

    // The app restarts its daemon: the socket drops, and opens on the new one.
    h.status.mockResolvedValue({ version: '0.78.1' })
    setConn('closed')
    expect(h.status).toHaveBeenCalledTimes(2)
    setConn('open')
    await waitFor(() => expect(result.current).toBe('0.78.1'))
  })

  it('is read again when the window regains focus', async () => {
    h.conn = 'open'
    h.status.mockResolvedValue({ version: '0.78.0' })
    const { result } = renderHook(() => useDaemonVersion())
    await waitFor(() => expect(result.current).toBe('0.78.0'))
    h.status.mockResolvedValue({ version: '0.78.1' })
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(result.current).toBe('0.78.1'))
  })

  it('keeps the last version when a read fails', async () => {
    h.conn = 'open'
    h.status.mockResolvedValue({ version: '0.78.0' })
    const { result } = renderHook(() => useDaemonVersion())
    await waitFor(() => expect(result.current).toBe('0.78.0'))
    h.status.mockRejectedValue(new Error('down'))
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(h.status).toHaveBeenCalledTimes(2))
    expect(result.current).toBe('0.78.0')
  })
})
