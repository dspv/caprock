/**
 * A browser tab's view (ADR-075): what it asks of the shell's page window
 * as the tab comes and goes, its address box, its keys and its nudge.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
import { ANDROID_CHROME_UA, IOS_SAFARI_UA, setPhoneOn } from '@/lib/phonemode'

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

describe('phone mode (ADR-075, amended 2026-10-21)', () => {
  // The tab's box is big enough for the whole phone at the default
  // interface size (1.1); the page area reports the size it is drawn at.
  beforeEach(() => {
    localStorage.clear()
    setPhoneOn('page:t1', false)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.phoneSize) {
        const w = parseFloat(this.style.width)
        const h = parseFloat(this.style.height)
        return { left: 400, top: 120, width: w, height: h, right: 400 + w, bottom: 120 + h, x: 400, y: 120, toJSON() {} } as DOMRect
      }
      return { left: 200, top: 78, width: 1000, height: 900, right: 1200, bottom: 978, x: 200, y: 78, toJSON() {} } as DOMRect
    })
  })
  const lastOpen = () => acts.list.filter((a) => a.act.do === 'open').at(-1)!.act as Extract<BrowserAct, { do: 'open' }>

  it('is a Phone button on the toolbar with its key named for this OS', () => {
    const { unmount } = render(<BrowserView {...props} visible armed />)
    const btn = screen.getByRole('button', { name: 'Phone' })
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(btn.getAttribute('title')).toContain('⌥⌘R')
    unmount()
    render(<BrowserView {...props} isMac={false} visible armed />)
    expect(screen.getByRole('button', { name: 'Phone' }).getAttribute('title')).toContain('Ctrl+Alt+Shift+D')
  })

  it('sizes the page window to the device’s page area and gives it the phone’s agent and touch', () => {
    render(<BrowserView {...props} visible armed />)
    expect(lastOpen().phone).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Phone' }))
    // iPhone 16, bars shown: 393 × (852 − 54 − 83 − 34), in logical px.
    expect(lastOpen()).toMatchObject({ rect: { width: 393, height: 681 }, phone: { ua: IOS_SAFARI_UA, touch: true } })
    expect(screen.getByText('393×681')).toBeTruthy()
    expect(screen.getByText('est.')).toBeTruthy()
    expect(document.querySelector('[data-phone-fit="full"]')).toBeTruthy()
    // Another device: its agent and its size.
    fireEvent.change(screen.getByRole('combobox', { name: 'Device' }), { target: { value: 'pixel9' } })
    expect(lastOpen()).toMatchObject({ rect: { width: 412, height: 803 }, phone: { ua: ANDROID_CHROME_UA, touch: true } })
    // Bars scrolled away: the second size.
    fireEvent.click(screen.getByRole('button', { name: 'Bars scrolled away' }))
    expect(lastOpen().rect).toMatchObject({ width: 412, height: 859 })
    // Rotate: the sides swap.
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }))
    expect(lastOpen().rect).toMatchObject({ width: 923, height: 412 - 16 })
    // Touch off: the same agent, touch off.
    fireEvent.click(screen.getByRole('button', { name: 'Touch' }))
    expect(lastOpen().phone).toEqual({ ua: ANDROID_CHROME_UA, touch: false })
    // Off: a desktop page over the whole box again.
    fireEvent.click(screen.getByRole('button', { name: 'Phone' }))
    expect(lastOpen().phone).toBeUndefined()
    expect(lastOpen().rect).toEqual({ x: 220, y: 86, width: 1100, height: 990 })
    // The device is remembered for the next time.
    fireEvent.click(screen.getByRole('button', { name: 'Phone' }))
    expect(lastOpen()).toMatchObject({ phone: { ua: ANDROID_CHROME_UA, touch: false } })
  })

  it('takes a custom size exactly, with no estimate', () => {
    render(<BrowserView {...props} visible armed />)
    fireEvent.click(screen.getByRole('button', { name: 'Phone' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Device' }), { target: { value: 'custom' } })
    const w = screen.getByRole('spinbutton', { name: 'Width' })
    fireEvent.change(w, { target: { value: '320' } })
    fireEvent.blur(w)
    expect(lastOpen().rect).toMatchObject({ width: 320, height: 700 })
    expect(screen.queryByText('est.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Bars shown' })).toBeNull()
  })

  it('draws the page area alone when the phone does not fit, never scaled', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.phoneSize) return { left: 0, top: 0, width: parseFloat(this.style.width), height: parseFloat(this.style.height), right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect
      return { left: 200, top: 78, width: 800, height: 700, right: 1000, bottom: 778, x: 200, y: 78, toJSON() {} } as DOMRect
    })
    render(<BrowserView {...props} visible armed />)
    fireEvent.click(screen.getByRole('button', { name: 'Phone' }))
    expect(document.querySelector('[data-phone-fit="page"]')).toBeTruthy()
    expect(lastOpen().rect).toMatchObject({ width: 393, height: 681 })
    expect(screen.getByText(/does not fit this tab/)).toBeTruthy()
  })

  it('turns on and off with ⌥⌘R in the dashboard, Ctrl+Alt+Shift+D off macOS, and from the page', () => {
    const { unmount } = render(<BrowserView {...props} visible armed />)
    fireEvent.keyDown(window, { key: '®', code: 'KeyR', metaKey: true, altKey: true })
    expect(screen.getByRole('button', { name: 'Phone' }).getAttribute('aria-pressed')).toBe('true')
    // From the page's window: the shell's word (browser.rs KEYS_SCRIPT).
    act(() => { window.dispatchEvent(new CustomEvent(BROWSER_EVENT, { detail: { id: 't1', key: 'phone' } })) })
    expect(screen.getByRole('button', { name: 'Phone' }).getAttribute('aria-pressed')).toBe('false')
    unmount()
    render(<BrowserView {...props} isMac={false} visible armed />)
    fireEvent.keyDown(window, { key: 'D', code: 'KeyD', ctrlKey: true, altKey: true, shiftKey: true })
    expect(screen.getByRole('button', { name: 'Phone' }).getAttribute('aria-pressed')).toBe('true')
  })

  // A phone preview (lib/devservers) starts in Phone mode, and beside a
  // terminal in a split it leaves that terminal its keys — Ctrl+L is the
  // shell's clear off macOS — until the preview's pane is focused.
  it('starts a phone preview in Phone mode, and leaves the keys to the terminal beside it on every OS', () => {
    const cases = [
      { isMac: true, key: 'pv-mac', keys: [{ key: '®', code: 'KeyR', metaKey: true, altKey: true }, { key: 'l', code: 'KeyL', metaKey: true }, { key: 'ArrowLeft', altKey: true }] },
      { isMac: false, key: 'pv-other', keys: [{ key: 'D', code: 'KeyD', ctrlKey: true, altKey: true, shiftKey: true }, { key: 'l', code: 'KeyL', ctrlKey: true }, { key: 'PageUp', ctrlKey: true }] },
    ]
    for (const c of cases) {
      const steps: number[] = []
      const el = (focused?: boolean) => <BrowserView {...props} pageKey={`page:${c.key}`} isMac={c.isMac} phoneFirst visible armed {...(focused === undefined ? {} : { focused })} onStep={(d) => steps.push(d)} />
      const phone = () => screen.getByRole('button', { name: 'Phone' }).getAttribute('aria-pressed')
      const view = render(el(false))
      expect(phone()).toBe('true')
      // The terminal in the split has the keyboard: none of the page's keys is taken.
      for (const k of c.keys) expect(fireEvent.keyDown(window, k)).toBe(true)
      expect(steps).toEqual([])
      expect(phone()).toBe('true')
      // Its own pane focused, the phone key is the page's again.
      view.rerender(el(true))
      expect(fireEvent.keyDown(window, c.keys[0]!)).toBe(false)
      expect(phone()).toBe('false')
      // Turned off by hand, it stays off for the window's life.
      view.unmount()
      render(el())
      expect(phone()).toBe('false')
      cleanup()
    }
  })

  it('shows the page side by side on three phones at their real widths, each its own window, reloaded together', () => {
    vi.useFakeTimers()
    render(<BrowserView {...props} visible armed />)
    fireEvent.click(screen.getByRole('button', { name: 'Phone' }))
    acts.list = []
    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }))
    // Remembered for this viewer.
    expect(JSON.parse(localStorage.getItem('caprock.app.browser-phone')!).side).toBe(true)
    // Three page windows: the tab's own is iPhone 16, two more beside it.
    const opens = acts.list.filter((a) => a.act.do === 'open') as { key: string; act: Extract<BrowserAct, { do: 'open' }> }[]
    expect(opens.map((o) => o.key).sort()).toEqual(['page:t1', 'page:t1-sbs-iphonese', 'page:t1-sbs-pixel9'])
    const by = (k: string) => opens.filter((o) => o.key === k).at(-1)!.act
    expect(by('page:t1-sbs-iphonese').phone).toMatchObject({ ua: IOS_SAFARI_UA, touch: true, width: 375 })
    expect(by('page:t1').phone).toMatchObject({ ua: IOS_SAFARI_UA, touch: true, width: 393 })
    expect(by('page:t1-sbs-pixel9').phone).toMatchObject({ ua: ANDROID_CHROME_UA, touch: true, width: 412 })
    // Drawn smaller than the phones, all at one scale; the shell zooms each page to its width.
    const scale = by('page:t1').rect.width / 393
    expect(scale).toBeLessThan(1)
    expect(by('page:t1-sbs-pixel9').rect.width / 412).toBeCloseTo(scale, 2)
    // Named under each phone; the bar has no device or rotate of its own.
    expect(screen.getByRole('button', { name: /^iPhone SE\s·\s375$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Pixel 9\s·\s412$/ })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Device' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull()
    expect(screen.getByText('375 · 393 · 412')).toBeTruthy()
    // Reload: all three.
    acts.list = []
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(acts.list.filter((a) => a.act.do === 'reload').map((a) => a.key).sort()).toEqual(['page:t1', 'page:t1-sbs-iphonese', 'page:t1-sbs-pixel9'])
    // Each is asked, every two seconds, whether its page runs past its edge.
    acts.list = []
    act(() => { vi.advanceTimersByTime(2000) })
    expect(acts.list.filter((a) => a.act.do === 'measure')).toHaveLength(3)
    // The SE's page is wider than the SE: cut off, on that phone alone.
    act(() => { window.dispatchEvent(new CustomEvent(BROWSER_EVENT, { detail: { id: 't1-sbs-iphonese', doc: 640, view: 375 } })) })
    act(() => { window.dispatchEvent(new CustomEvent(BROWSER_EVENT, { detail: { id: 't1', doc: 393, view: 393 } })) })
    expect(document.querySelector('[data-cut-off="iphonese"]')).toBeTruthy()
    expect(document.querySelectorAll('[data-cut-off]')).toHaveLength(1)
    // It fits again after a save: the mark goes.
    act(() => { window.dispatchEvent(new CustomEvent(BROWSER_EVENT, { detail: { id: 't1-sbs-iphonese', doc: 375, view: 375 } })) })
    expect(document.querySelector('[data-cut-off]')).toBeNull()
    // A phone's name: back to that one phone; the two extra windows close.
    acts.list = []
    fireEvent.click(screen.getByRole('button', { name: /^iPhone SE\s·\s375$/ }))
    expect(acts.list.filter((a) => a.act.do === 'close').map((a) => a.key).sort()).toEqual(['page:t1-sbs-iphonese', 'page:t1-sbs-pixel9'])
    expect(lastOpen()).toMatchObject({ rect: { width: 375 }, phone: { ua: IOS_SAFARI_UA, touch: true } })
    expect(lastOpen().phone!.width).toBeUndefined()
    expect(screen.getByRole('button', { name: 'Side by side' }).getAttribute('aria-pressed')).toBe('false')
    expect((screen.getByRole('combobox', { name: 'Device' }) as HTMLSelectElement).value).toBe('iphonese')
  })

  it('hides a side-by-side phone scrolled out of the pane rather than draw it over the panes beside', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.phoneSize) {
        const w = parseFloat(this.style.width)
        const h = parseFloat(this.style.height)
        // The Pixel sits past the pane's right edge.
        const left = this.closest('[data-side-phone="pixel9"]') ? 1100 : 400
        return { left, top: 120, width: w, height: h, right: left + w, bottom: 120 + h, x: left, y: 120, toJSON() {} } as DOMRect
      }
      return { left: 200, top: 78, width: 1000, height: 900, right: 1200, bottom: 978, x: 200, y: 78, toJSON() {} } as DOMRect
    })
    localStorage.setItem('caprock.app.browser-phone', JSON.stringify({ side: true }))
    render(<BrowserView {...props} visible armed />)
    fireEvent.click(screen.getByRole('button', { name: 'Phone' }))
    expect([...new Set(acts.list.filter((a) => a.act.do === 'open').map((a) => a.key))].sort()).toEqual(['page:t1', 'page:t1-sbs-iphonese'])
    expect(screen.getByText('Scroll to see this phone')).toBeTruthy()
  })

  it('says how true it is, per OS, behind its ?', () => {
    render(<BrowserView {...props} visible armed />)
    fireEvent.click(screen.getByRole('button', { name: 'Phone' }))
    fireEvent.click(screen.getByRole('button', { name: 'How true phone mode is' }))
    const list = screen.getByRole('dialog', { name: 'How true phone mode is' })
    expect(list.textContent).toContain('Touch')
    expect(list.querySelector('[data-truth="approx"]')).toBeTruthy()
    expect(list.querySelector('[data-truth="no"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Windows' }))
    expect(list.textContent).toContain('Chromium wearing an iPhone size')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'How true phone mode is' })).toBeNull()
  })
})

describe('a browser tab outside the app', () => {
  it('never asks for a page window', () => {
    render(<BrowserView {...props} inApp={false} visible armed />)
    expect(does()).toEqual([])
    expect(screen.getByText(/part of the desktop app/)).toBeTruthy()
  })
})
