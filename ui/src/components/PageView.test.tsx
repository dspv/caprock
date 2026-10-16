/**
 * The Page tab's view (ADR-070): what it asks of the shell's native page as
 * the tab comes and goes, and what a browser shows instead.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PageAct } from '@/lib/pagetab'

const acts = vi.hoisted(() => ({ list: [] as { key: string; act: PageAct }[] }))
vi.mock('@/lib/pagetab', async (orig) => ({
  ...(await orig<typeof import('@/lib/pagetab')>()),
  pageAct: (key: string, act: PageAct) => { acts.list.push({ key, act }); return Promise.resolve() },
}))
const opened = vi.hoisted(() => ({ list: [] as string[] }))
vi.mock('@/lib/termlinks', async (orig) => ({
  ...(await orig<typeof import('@/lib/termlinks')>()),
  openLink: (u: string) => { opened.list.push(u) },
}))

import { OpenPageSheet, PageView } from './PageView'
import { OPEN_PAGE_EVENT, PAGE_EVENT, UNLOAD_AFTER_MS } from '@/lib/pagetab'

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

const props = { pageKey: 'page:t1', url: 'http://localhost:5173/', onArm: () => {}, onNav: () => {}, onOpenPage: () => {}, onClose: () => {} }

describe('PageView in the app', () => {
  it('opens the page over its box when in front, hides it behind, and frees it after a while', () => {
    vi.useFakeTimers()
    const { rerender, unmount } = render(<PageView {...props} visible armed inApp />)
    // The box times the interface size (1.1 by default).
    expect(acts.list[0]).toEqual({ key: 'page:t1', act: { do: 'open', url: 'http://localhost:5173/', rect: { x: 220, y: 86, width: 880, height: 550 } } })
    rerender(<PageView {...props} visible={false} armed inApp />)
    expect(acts.list.at(-1)!.act).toEqual({ do: 'hide' })
    act(() => { vi.advanceTimersByTime(UNLOAD_AFTER_MS) })
    expect(acts.list.at(-1)!.act).toEqual({ do: 'close' })
    rerender(<PageView {...props} visible armed inApp />)
    expect(acts.list.at(-1)!.act.do).toBe('open')
    unmount()
    expect(acts.list.at(-1)!.act).toEqual({ do: 'close' })
  })

  it('loads nothing until asked: a restored tab waits on a click', () => {
    const onArm = vi.fn()
    render(<PageView {...props} visible armed={false} inApp onArm={onArm} />)
    expect(acts.list.filter((a) => a.act.do === 'open')).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Load the page' }))
    expect(onArm).toHaveBeenCalled()
  })

  it('hides the page while a sheet or a menu is on screen', async () => {
    render(<PageView {...props} visible armed inApp />)
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.getClientRects = () => [{}] as unknown as DOMRectList
    await act(async () => {
      document.body.append(menu)
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
    expect(acts.list.at(-1)!.act).toEqual({ do: 'hide' })
    await act(async () => {
      menu.remove()
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
    expect(acts.list.at(-1)!.act.do).toBe('open')
  })

  it('follows the shell: a title, a new address, a new window, a download', () => {
    const onNav = vi.fn()
    const onOpenPage = vi.fn()
    render(<PageView {...props} visible armed inApp onNav={onNav} onOpenPage={onOpenPage} />)
    const tell = (detail: object) => act(() => { window.dispatchEvent(new CustomEvent(PAGE_EVENT, { detail: { id: 't1', ...detail } })) })
    tell({ url: 'http://localhost:5173/a', loading: true })
    expect(onNav).not.toHaveBeenCalled()
    tell({ url: 'http://localhost:5173/a', loading: false })
    expect(onNav).toHaveBeenLastCalledWith('http://localhost:5173/a')
    tell({ title: 'Vite App' })
    expect(onNav).toHaveBeenLastCalledWith(undefined, 'Vite App')
    tell({ open: 'https://vitejs.dev/' })
    expect(onOpenPage).toHaveBeenCalledWith('https://vitejs.dev/')
    tell({ saved: 'report.pdf', ok: true })
    expect(screen.getByRole('status').textContent).toContain('Saved report.pdf to Downloads')
    // Another page's news is not this one's.
    window.dispatchEvent(new CustomEvent(PAGE_EVENT, { detail: { id: 'other', title: 'x' } }))
    expect(onNav).toHaveBeenCalledTimes(2)
  })

  it('goes where the address field says, and back, forward and reload', () => {
    const onNav = vi.fn()
    render(<PageView {...props} visible armed inApp onNav={onNav} />)
    const field = screen.getByRole('textbox', { name: 'Address' })
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: 'localhost:3000/docs' } })
    fireEvent.submit(field.closest('form')!)
    expect(onNav).toHaveBeenCalledWith('http://localhost:3000/docs')
    expect(acts.list.at(-1)!.act).toEqual({ do: 'go', url: 'http://localhost:3000/docs' })
    for (const [name, d] of [['Back', 'back'], ['Forward', 'forward'], ['Reload', 'reload']] as const) {
      fireEvent.click(screen.getByRole('button', { name }))
      expect(acts.list.at(-1)!.act).toEqual({ do: d })
    }
    fireEvent.click(screen.getByRole('button', { name: 'Open in your browser' }))
    expect(opened.list).toEqual(['http://localhost:5173/'])
  })
})

describe('PageView in a browser', () => {
  it('frames a page on this machine and asks the shell for nothing', () => {
    const { container } = render(<PageView {...props} visible armed inApp={false} />)
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe('http://localhost:5173/')
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts')
    expect(acts.list).toEqual([])
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends any other address to the browser', () => {
    const { container } = render(<PageView {...props} url="https://github.com/" visible armed inApp={false} />)
    expect(container.querySelector('iframe')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Open in your browser' }).at(-1)!)
    expect(opened.list).toEqual(['https://github.com/'])
  })
})

describe('OpenPageSheet', () => {
  it('opens what was typed as a page, and nothing that is not an address', () => {
    const asked: string[] = []
    const on = (e: Event) => asked.push((e as CustomEvent<{ url: string }>).detail.url)
    window.addEventListener(OPEN_PAGE_EVENT, on)
    const onClose = vi.fn()
    render(<OpenPageSheet onClose={onClose} inApp />)
    const field = screen.getByRole('textbox', { name: 'Open a page' })
    fireEvent.change(field, { target: { value: 'fix the login' } })
    expect((screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(field, { target: { value: 'localhost:5173' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(asked).toEqual(['http://localhost:5173/'])
    expect(onClose).toHaveBeenCalled()
    window.removeEventListener(OPEN_PAGE_EVENT, on)
  })
})
