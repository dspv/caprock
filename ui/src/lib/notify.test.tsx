import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NotifyFrame } from './live'
import { live } from './live'
import { CLICK_WINDOW_MS, Notifier, promptRoute, useOsNotifications, type Viewing } from './notify'

const approval = (over: Partial<NotifyFrame> = {}): NotifyFrame => ({
  id: 'approval-s1-1',
  kind: 'approval',
  session_id: 's1',
  project: 'caprock',
  title: 'Needs approval · caprock',
  body: 'Tidy the cache · main\nBash: go test ./...',
  prompt_id: 'p1',
  actions: ['allow', 'deny'],
  ...over,
})

function setup(viewing: Viewing, waiting = true) {
  let t = 1_000
  const v = { ...viewing }
  const invoke = vi.fn(async () => undefined)
  const open = vi.fn()
  const stillWaiting = vi.fn(async () => waiting)
  const n = new Notifier({ invoke, open, stillWaiting, viewing: () => v, now: () => t })
  return { n, v, invoke, open, stillWaiting, advance: (ms: number) => { t += ms } }
}

describe('Notifier', () => {
  it('shows what the daemon wrote, once per id', async () => {
    const { n, invoke } = setup({ focused: false })
    expect(await n.receive(approval())).toBe(true)
    expect(await n.receive(approval())).toBe(false) // a replay after a reconnect
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('notify', { title: 'Needs approval · caprock', body: 'Tidy the cache · main\nBash: go test ./...' })
  })

  it('is quiet for the session in front of a focused window, and only then', async () => {
    expect(await setup({ focused: true, sessionId: 's1' }).n.receive(approval())).toBe(false)
    expect(await setup({ focused: false, sessionId: 's1' }).n.receive(approval())).toBe(true)
    expect(await setup({ focused: true, sessionId: 's2' }).n.receive(approval())).toBe(true)
  })

  it('does not show an approval whose prompt is no longer waiting', async () => {
    const { n, invoke, stillWaiting } = setup({ focused: false }, false)
    expect(await n.receive(approval())).toBe(false)
    expect(stillWaiting).toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    // Without a prompt (another agent, a finished run) there is nothing to check.
    expect(await n.receive(approval({ id: 'f', kind: 'finished', prompt_id: undefined, actions: undefined }))).toBe(true)
  })

  it('opens the session when the app comes forward soon after, as a click does', async () => {
    const { n, open } = setup({ focused: false })
    await n.receive(approval())
    n.focused()
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ session_id: 's1' }))
    n.focused()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does not open anything later, after an answer elsewhere, or when the window was in front', async () => {
    const late = setup({ focused: false })
    await late.n.receive(approval())
    late.advance(CLICK_WINDOW_MS + 1)
    late.n.focused()
    expect(late.open).not.toHaveBeenCalled()

    const answered = setup({ focused: false })
    await answered.n.receive(approval())
    answered.n.answered('s1')
    answered.n.focused()
    expect(answered.open).not.toHaveBeenCalled()

    const inFront = setup({ focused: true, sessionId: 's2' })
    await inFront.n.receive(approval())
    inFront.n.focused()
    expect(inFront.open).not.toHaveBeenCalled()
  })

  it('opens the session with its prompt card in view', () => {
    expect(promptRoute(approval())).toBe('#/session/s1?tab=terminal')
  })
})

describe('useOsNotifications', () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  const frame = (id: string) => ({ type: 'notify' as const, data: approval({ id, kind: 'finished', prompt_id: undefined }) })

  it('does nothing in a browser tab', async () => {
    const { unmount } = renderHook(() => useOsNotifications(undefined))
    expect(() => live.handle(frame('browser-1'))).not.toThrow()
    unmount()
  })

  it('asks the shell to show a notify frame in the app', async () => {
    const invoke = vi.fn(async () => undefined)
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke }
    const { unmount } = renderHook(() => useOsNotifications('s9'))
    live.handle(frame('app-1'))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('notify', expect.objectContaining({ title: 'Needs approval · caprock' })))
    unmount()
  })
})
