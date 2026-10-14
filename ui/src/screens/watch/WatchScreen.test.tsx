/**
 * The Watch tab: no frame before Play, the privacy-enhanced player after it,
 * and a strip with Go — and a pause — when an agent turns to waiting.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WatchScreen, WATCH_SOURCE_LINE, waitsOf } from './WatchScreen'
import { PAUSE_MESSAGE, type WaitItem } from '@/lib/watch'
import type { SessionSummary } from '@/lib/api'

const ID = 'aqz-KE-bpKQ'

function play(link = `https://www.youtube.com/watch?v=${ID}`) {
  fireEvent.change(screen.getByLabelText('YouTube link'), { target: { value: link } })
  fireEvent.click(screen.getByText('Play'))
}

beforeEach(() => localStorage.clear())

describe('WatchScreen', () => {
  it('loads nothing from YouTube before Play, and says where the video comes from', () => {
    const { container } = render(<WatchScreen waiting={[]} />)
    expect(container.querySelector('iframe')).toBe(null)
    expect(screen.getByText(WATCH_SOURCE_LINE)).toBeTruthy()
    expect(WATCH_SOURCE_LINE).toMatch(/YouTube/)
    expect(WATCH_SOURCE_LINE).toMatch(/No search/)
  })

  it('plays a pasted link in the privacy-enhanced player, sandboxed, sending the origin', () => {
    const { container } = render(<WatchScreen waiting={[]} />)
    play()
    const f = container.querySelector('iframe')!
    expect(new URL(f.src).origin).toBe('https://www.youtube-nocookie.com')
    expect(f.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin')
    expect(f.getAttribute('sandbox')).not.toMatch(/allow-top-navigation/)
    expect(screen.getByText(`youtu.be/${ID}`)).toBeTruthy() // kept in Recent
  })

  it('says so when a link is not a YouTube one, and plays nothing', () => {
    const { container } = render(<WatchScreen waiting={[]} />)
    play('https://vimeo.com/1')
    expect(screen.getByRole('alert').textContent).toMatch(/not a YouTube/)
    expect(container.querySelector('iframe')).toBe(null)
  })

  it('an agent that turns to waiting: a strip with Go, and the video paused', () => {
    const t0 = Date.now()
    const onGo = vi.fn()
    const before: WaitItem[] = [{ sessionId: 'old', title: 'Old one', reason: 'waiting', since: t0 - 60_000 }]
    const { container, rerender } = render(<WatchScreen waiting={before} onGo={onGo} />)
    // Already waiting when the tab opened: no strip.
    expect(container.querySelector('[data-watch-nudge]')).toBe(null)
    play()
    const post = vi.fn()
    const f = container.querySelector('iframe')!
    Object.defineProperty(f, 'contentWindow', { value: { postMessage: post } })
    act(() => rerender(<WatchScreen waiting={[...before, { sessionId: 's1', title: 'caprock', reason: 'waiting', since: t0 + 1000 }]} onGo={onGo} />))
    expect(container.querySelector('[data-watch-nudge]')!.textContent).toMatch('caprock is waiting for you')
    expect(post).toHaveBeenCalledWith(PAUSE_MESSAGE, 'https://www.youtube-nocookie.com')
    fireEvent.click(screen.getByText('Go'))
    expect(onGo).toHaveBeenCalledWith('s1')
    expect(container.querySelector('[data-watch-nudge]')).toBe(null)
  })

  it('does not pause with the setting off, and the strip leaves when the wait ends', () => {
    const t0 = Date.now()
    const { container, rerender } = render(<WatchScreen waiting={[]} />)
    fireEvent.click(screen.getByLabelText('Pause when an agent needs me'))
    expect(JSON.parse(localStorage.getItem('caprock.watch')!).pause).toBe(false)
    play()
    const post = vi.fn()
    Object.defineProperty(container.querySelector('iframe')!, 'contentWindow', { value: { postMessage: post } })
    act(() => rerender(<WatchScreen waiting={[{ sessionId: 's2', title: 'api', reason: 'permission', since: t0 + 1000 }]} />))
    expect(container.querySelector('[data-watch-nudge]')!.textContent).toMatch('api needs your permission')
    expect(post).not.toHaveBeenCalled()
    act(() => rerender(<WatchScreen waiting={[]} />))
    expect(container.querySelector('[data-watch-nudge]')).toBe(null)
  })

  it('the browser counts waiting agents as the sidebar does', () => {
    const now = Date.now()
    const s = (id: string, health: string, extra: Partial<SessionSummary> = {}) => ({
      session_id: id, status: 'active', last_event_at: now, activity: { phrase: '', at: new Date(now).toISOString(), health }, ...extra,
    }) as unknown as SessionSummary
    const got = waitsOf([
      s('a', 'waiting-on-you'),
      s('b', 'working'),
      s('c', 'waiting-on-you', { kind: 'shell' } as Partial<SessionSummary>),
      s('d', 'waiting-on-you', { status: 'ended' } as Partial<SessionSummary>),
      s('e', 'waiting-on-you', { activity: { phrase: '', at: new Date(now - 13 * 3600_000).toISOString(), health: 'waiting-on-you' } } as Partial<SessionSummary>),
    ], now)
    expect(got.map((w) => w.sessionId)).toEqual(['a'])
  })
})
