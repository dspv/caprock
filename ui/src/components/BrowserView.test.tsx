/**
 * A browser tab's view (ADR-075): what it asks of the shell's page window
 * as the tab comes and goes, its address box, its keys and its nudge.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserAct } from '@/lib/browsertab'

const acts = vi.hoisted(() => ({ list: [] as { key: string; act: BrowserAct }[] }))
vi.mock('@/lib/browsertab', async (orig) => ({
  ...(await orig<typeof import('@/lib/browsertab')>()),
  browserAct: (key: string, act: BrowserAct) => { acts.list.push({ key, act }); return Promise.resolve() },
}))
const opened = vi.hoisted(() => ({ list: [] as string[] }))
vi.mock('@/lib/termlinks', async (orig) => ({
  ...(await orig<typeof import('@/lib/termlinks')>()),
  openLink: (u: string) => { opened.list.push(u) },
}))

import { BrowserView } from './BrowserView'
import { BROWSER_EVENT } from '@/lib/browsertab'

class RO { observe() {} disconnect() {} }

beforeEach(() => {
  acts.list = []
  opened.list = []
  vi.stubGlobal('ResizeObserver', RO)
  // jsdom lays nothing out: the box gets a place by hand.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 200, top: 78, width: 800, height: 500, right: 1000, bottom: 578, x: 200, y: 78, toJSON() {} } as DOMRect)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const props = {
  pageKey: 'page:t1',
  url: 'http://localhost:5173/',
  onArm: () => {},
  onNav: () => {},
  onOpenPage: () => {},
  onClose: () => {},
  onStep: () => {},
  engine: 'duckduckgo',
  pause: true,
  isMac: true,
  inApp: true,
}
const does = () => acts.list.map((a) => a.act.do)

describe('a browser tab in the app', () => {
  it('opens its page over the box when in front, only hides it behind, and closes it with the tab', () => {
    vi.useFakeTimers()
    const { rerender, unmount } = render(<BrowserView {...props} visible armed />)
    // The box times the interface size (1.1 by default).
    expect(acts.list[0]).toEqual({ key: 'page:t1', act: { do: 'open', url: 'http://localhost:5173/', rect: { x: 220, y: 86, width: 880, height: 550 }, focus: false } })
    rerender(<BrowserView {...props} visible={false} armed />)
    expect(acts.list.at(-1)!.act).toEqual({ do: 'hide' })
    // Behind for an hour: still only hidden, so it comes back exactly where it was.
    act(() => { vi.advanceTimersByTime(60 * 60_000) })
    expect(does()).not.toContain('close')
    rerender(<BrowserView {...props} visible armed />)
    expect(acts.list.at(-1)!.act.do).toBe('open')
    unmount()
    expect(acts.list.at(-1)!.act).toEqual({ do: 'close' })
  })

  it('closes its page when the in-app browser is turned off, and opens none while it is off', () => {
    const { rerender } = render(<BrowserView {...props} visible armed />)
    expect(does()).toEqual(['open'])
    rerender(<BrowserView {...props} visible armed enabled={false} />)
    expect(does()).toEqual(['open', 'close'])
    expect(screen.getByText(/The in-app browser is off/)).toBeTruthy()
    acts.list = []
    render(<BrowserView {...props} pageKey="page:t2" visible armed enabled={false} />)
    expect(does()).toEqual([])
  })

  it('loads nothing until asked: a restored tab waits on a click', () => {
    const onArm = vi.fn()
    render(<BrowserView {...props} visible armed={false} onArm={onArm} />)
    expect(does()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Load the page' }))
    expect(onArm).toHaveBeenCalled()
  })

  it('hides the page while a sheet or a menu is over it', async () => {
    render(<BrowserView {...props} visible armed />)
    const sheet = document.createElement('div')
    sheet.setAttribute('role', 'dialog')
    sheet.getClientRects = () => [{}] as unknown as DOMRectList
    await act(async () => {
      document.body.append(sheet)
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
    expect(acts.list.at(-1)!.act).toEqual({ do: 'hide' })
    sheet.remove()
  })

  it('starts a new tab in its address box and searches plain words', () => {
    const onNav = vi.fn()
    const onArm = vi.fn()
    render(<BrowserView {...props} url="" visible armed={false} onNav={onNav} onArm={onArm} />)
    const box = screen.getByRole('textbox', { name: 'Address or search' })
    expect(document.activeElement).toBe(box)
    expect(box.getAttribute('placeholder')).toContain('DuckDuckGo')
    expect(does()).toEqual([])
    fireEvent.change(box, { target: { value: 'tauri child window' } })
    fireEvent.submit(box.closest('form')!)
    expect(onNav).toHaveBeenCalledWith('https://duckduckgo.com/?q=tauri%20child%20window')
    expect(onArm).toHaveBeenCalled()
  })

  it('sends an open page to a typed address and gives it the keyboard', async () => {
    render(<BrowserView {...props} visible armed />)
    const box = screen.getByRole('textbox', { name: 'Address or search' })
    fireEvent.change(box, { target: { value: 'example.com' } })
    await act(async () => { fireEvent.submit(box.closest('form')!) })
    expect(acts.list.slice(-2).map((a) => a.act)).toEqual([{ do: 'go', url: 'https://example.com/' }, { do: 'focus' }])
  })

  it('hears its page: where it went, its title, a new window, a key', () => {
    const onNav = vi.fn()
    const onOpenPage = vi.fn()
    const onStep = vi.fn()
    render(<BrowserView {...props} visible armed onNav={onNav} onOpenPage={onOpenPage} onStep={onStep} />)
    const say = (detail: object) => act(() => { window.dispatchEvent(new CustomEvent(BROWSER_EVENT, { detail: { id: 't1', ...detail } })) })
    say({ url: 'http://localhost:5173/about', loading: false })
    expect(onNav).toHaveBeenCalledWith('http://localhost:5173/about')
    say({ title: 'About' })
    expect(onNav).toHaveBeenCalledWith(undefined, 'About')
    say({ open: 'https://example.com/' })
    expect(onOpenPage).toHaveBeenCalledWith('https://example.com/')
    say({ key: 'next' })
    expect(onStep).toHaveBeenCalledWith(1)
    say({ key: 'address' })
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Address or search' }))
    // Another tab's news is not its own.
    say({ id: 't2', key: 'prev' })
    expect(onStep).toHaveBeenCalledTimes(1)
  })

  it('steps between tabs with ⌥← ⌥→ outside the address box, Ctrl+PageUp/PageDown off macOS', () => {
    const onStep = vi.fn()
    const { unmount } = render(<BrowserView {...props} visible armed onStep={onStep} />)
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true })
    expect(onStep).toHaveBeenLastCalledWith(1)
    // In the address box ⌥← is its word jump.
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Address or search' }), { key: 'ArrowLeft', altKey: true })
    expect(onStep).toHaveBeenCalledTimes(1)
    unmount()
    render(<BrowserView {...props} isMac={false} visible armed onStep={onStep} />)
    fireEvent.keyDown(window, { key: 'PageUp', ctrlKey: true })
    expect(onStep).toHaveBeenLastCalledWith(-1)
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true })
    expect(onStep).toHaveBeenCalledTimes(2)
  })

  it('names an agent that starts waiting on you, pauses the video, and goes to it', () => {
    const onGo = vi.fn()
    const { rerender } = render(<BrowserView {...props} visible armed waiting={[{ id: 'old', title: 'Old' }]} onGoWaiting={onGo} />)
    // One already waiting when the tab came up is not news.
    expect(screen.queryByText(/is waiting for you/)).toBeNull()
    rerender(<BrowserView {...props} visible armed waiting={[{ id: 'old', title: 'Old' }, { id: 's2', title: 'fix login' }]} onGoWaiting={onGo} />)
    expect(screen.getByText('fix login')).toBeTruthy()
    expect(acts.list.at(-1)!.act).toEqual({ do: 'pause' })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(onGo).toHaveBeenCalledWith('s2')
  })

  it('pauses nothing when told not to', () => {
    const { rerender } = render(<BrowserView {...props} pause={false} visible armed waiting={[]} />)
    rerender(<BrowserView {...props} pause={false} visible armed waiting={[{ id: 's2', title: 'fix login' }]} />)
    expect(screen.getByText('fix login')).toBeTruthy()
    expect(does()).not.toContain('pause')
  })

  it('copies its address and opens it in your browser', () => {
    render(<BrowserView {...props} visible armed />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in your browser' }))
    expect(opened.list).toEqual(['http://localhost:5173/'])
  })
})

describe('a browser tab outside the app', () => {
  it('never asks for a page window', () => {
    render(<BrowserView {...props} inApp={false} visible armed />)
    expect(does()).toEqual([])
    expect(screen.getByText(/part of the desktop app/)).toBeTruthy()
  })
})
