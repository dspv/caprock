import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addressOrSearch,
  BROWSER_ON_KEY,
  browserKey,
  browserOn,
  isLocalUrl,
  loadBrowserPrefs,
  looksLikeAddress,
  newPageKey,
  OPEN_BROWSER_EVENT,
  openInCaprock,
  overlayOpen,
  pageId,
  pageTitle,
  pageUrl,
  pickCaprock,
  rectOf,
  sameRect,
  saveBrowserPrefs,
  searchUrl,
  TURNED_ON_NOTICE,
  type BrowserKeyLike,
} from './browsertab'

vi.mock('./appmode', async (orig) => ({ ...(await orig<typeof import('./appmode')>()), isTauri: () => true }))


describe('pageUrl', () => {
  it('reads what people type into the address field or ⌘K', () => {
    expect(pageUrl('localhost:5173')).toBe('http://localhost:5173/')
    expect(pageUrl(':3000/docs')).toBe('http://localhost:3000/docs')
    expect(pageUrl('127.0.0.1:8080/x?y=1')).toBe('http://127.0.0.1:8080/x?y=1')
    expect(pageUrl('app.localhost:4000')).toBe('http://app.localhost:4000/')
    expect(pageUrl('example.com')).toBe('https://example.com/')
    expect(pageUrl('github.com/dspv/caprock')).toBe('https://github.com/dspv/caprock')
    expect(pageUrl('  https://example.com/a  ')).toBe('https://example.com/a')
    expect(pageUrl('HTTP://Example.com')).toBe('http://example.com/')
  })

  it('is not an address for a word, a path, a version or another scheme', () => {
    for (const bad of ['', 'fix the login', 'README.md x', 'src/app.ts', 'v1.2', '1.2.3', 'file:///etc/hosts', 'javascript:alert(1)', 'vscode://open', 'mailto:a@b.c', 'ftp://x.y']) {
      expect(pageUrl(bad), bad).toBeNull()
    }
  })
})

describe('looksLikeAddress', () => {
  it('offers a page in ⌘K only for what is surely an address', () => {
    for (const yes of ['localhost:5173', ':3000', 'https://x.y/', 'example.com', 'docs.github.com/en']) expect(looksLikeAddress(yes), yes).toBe(true)
    for (const no of ['README.md', 'main.go', 'deploy.sh', 'fix the build', 'v1.2']) expect(looksLikeAddress(no), no).toBe(false)
  })
})

describe('this machine', () => {
  it('knows this machine by name and address', () => {
    expect(isLocalUrl('http://localhost:1/')).toBe(true)
    expect(isLocalUrl('http://127.4.5.6/')).toBe(true)
    expect(isLocalUrl('http://web.localhost/')).toBe(true)
    expect(isLocalUrl('http://localhost.example.com/')).toBe(false)
    expect(isLocalUrl('http://192.168.1.5/')).toBe(false)
  })
})

describe('the address box', () => {
  it('goes to an address and searches for anything else, with DuckDuckGo by default', () => {
    expect(addressOrSearch('example.com', 'duckduckgo')).toBe('https://example.com/')
    expect(addressOrSearch('localhost:5173', 'duckduckgo')).toBe('http://localhost:5173/')
    expect(addressOrSearch('rust borrow checker', 'duckduckgo')).toBe('https://duckduckgo.com/?q=rust%20borrow%20checker')
    expect(addressOrSearch('caprock', 'google')).toBe('https://www.google.com/search?q=caprock')
    expect(addressOrSearch('a&b=c', 'bing')).toBe('https://www.bing.com/search?q=a%26b%3Dc')
    // An unknown engine is DuckDuckGo; nothing typed goes nowhere.
    expect(searchUrl('x', 'nope')).toBe('https://duckduckgo.com/?q=x')
    expect(addressOrSearch('   ', 'duckduckgo')).toBeNull()
    // Another scheme is never followed: it is searched for as words.
    expect(addressOrSearch('javascript:alert(1)', 'duckduckgo')).toBe('https://duckduckgo.com/?q=javascript%3Aalert(1)')
  })
})

describe('the setting', () => {
  afterEach(() => localStorage.clear())

  it('is off until turned on, and then opens a link in Caprock', () => {
    expect(loadBrowserPrefs()).toEqual({ on: false, engine: 'duckduckgo', pause: true })
    expect(browserOn()).toBe(false)
    const asked = vi.fn()
    window.addEventListener(OPEN_BROWSER_EVENT, asked)
    expect(openInCaprock('https://example.com/')).toBe(false)
    expect(asked).not.toHaveBeenCalled()
    saveBrowserPrefs({ on: true, engine: 'brave' })
    expect(localStorage.getItem(BROWSER_ON_KEY)).toBe('on')
    expect(loadBrowserPrefs().engine).toBe('brave')
    expect(openInCaprock('example.com', 's1')).toBe(true)
    expect((asked.mock.calls[0]![0] as CustomEvent).detail).toEqual({ url: 'https://example.com/', sessionId: 's1' })
    expect(openInCaprock('file:///etc/hosts')).toBe(false)
    window.removeEventListener(OPEN_BROWSER_EVENT, asked)
  })

  it('needs the desktop app', () => {
    saveBrowserPrefs({ on: true })
    expect(browserOn(false)).toBe(false)
    expect(pickCaprock('https://example.com/', false)).toBe(false)
  })

  it('turns the in-app browser on when the chooser picks it, and says so once', () => {
    const asked = vi.fn()
    window.addEventListener(OPEN_BROWSER_EVENT, asked)
    expect(pickCaprock('https://example.com/a', true)).toBe(true)
    expect(localStorage.getItem(BROWSER_ON_KEY)).toBe('on')
    expect((asked.mock.calls[0]![0] as CustomEvent).detail).toEqual({ url: 'https://example.com/a', notice: TURNED_ON_NOTICE })
    // Already on: it just opens, with no toast.
    expect(pickCaprock('https://example.com/b', true)).toBe(true)
    expect((asked.mock.calls[1]![0] as CustomEvent).detail).toEqual({ url: 'https://example.com/b' })
    // Not a web address: nothing asked for.
    expect(pickCaprock('file:///etc/hosts', true)).toBe(false)
    expect(asked).toHaveBeenCalledTimes(2)
    window.removeEventListener(OPEN_BROWSER_EVENT, asked)
  })
})

// Rule 12: the tab keys are checked as macOS, Windows and Linux spell them.
describe('a browser tab\'s keys', () => {
  const k = (key: string, mods: Partial<BrowserKeyLike> = {}, code?: string): BrowserKeyLike => ({ key, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods })

  it('steps between tabs with ⌥← ⌥→ on macOS, outside a text field', () => {
    expect(browserKey(k('ArrowLeft', { altKey: true }), true)).toBe('prev')
    expect(browserKey(k('ArrowRight', { altKey: true }), true)).toBe('next')
    // In a field ⌥← ⌥→ stay its word jump.
    expect(browserKey(k('ArrowLeft', { altKey: true }), true, true)).toBeNull()
    // ⌥⌘ arrows are the sidebar's, ⌥⇧ arrows select by word.
    expect(browserKey(k('ArrowLeft', { altKey: true, metaKey: true }), true)).toBeNull()
    expect(browserKey(k('ArrowLeft', { altKey: true, shiftKey: true }), true)).toBeNull()
    expect(browserKey(k('l', { metaKey: true }, 'KeyL'), true)).toBe('address')
  })

  it('steps with Ctrl+PageUp and Ctrl+PageDown off macOS, where Alt+← → are Back and Forward', () => {
    expect(browserKey(k('PageUp', { ctrlKey: true }), false)).toBe('prev')
    expect(browserKey(k('PageDown', { ctrlKey: true }), false, true)).toBe('next')
    expect(browserKey(k('ArrowLeft', { altKey: true }), false)).toBeNull()
    expect(browserKey(k('l', { ctrlKey: true }, 'KeyL'), false)).toBe('address')
    // The macOS chords mean nothing there, and the other way round.
    expect(browserKey(k('PageUp', { ctrlKey: true }), true)).toBeNull()
    expect(browserKey(k('l', { metaKey: true }, 'KeyL'), false)).toBeNull()
  })
})

describe('a browser tab', () => {
  it('is named by its title, else its host, and New tab before it goes anywhere', () => {
    expect(pageTitle('')).toBe('New tab')
    expect(pageTitle('http://localhost:5173/x', '  ')).toBe('localhost:5173')
    expect(pageTitle('https://example.com/', 'Example Domain')).toBe('Example Domain')
  })

  it('has a key the shell takes as a window label', () => {
    const a = newPageKey(1000)
    const b = newPageKey(1000)
    expect(a).toMatch(/^page:[a-z0-9-]+$/)
    expect(a).not.toBe(b)
    expect(pageId(a)).toMatch(/^[A-Za-z0-9-]{1,64}$/)
    expect(pageId('page:a/b c')).toBe('a-b-c')
  })

  it('is placed in the window\'s logical pixels: the CSS box times the zoom', () => {
    expect(rectOf({ left: 260, top: 72, width: 900.4, height: 600 }, 1.1)).toEqual({ x: 286, y: 79, width: 990, height: 660 })
    expect(rectOf({ left: 10, top: 10, width: 10, height: 10 }, Number.NaN)).toEqual({ x: 10, y: 10, width: 10, height: 10 })
    expect(sameRect({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 })).toBe(true)
    expect(sameRect(null, { x: 1, y: 2, width: 3, height: 4 })).toBe(false)
  })
})

describe('overlayOpen', () => {
  // jsdom lays nothing out, so a shown element gets one client rect by hand.
  const shown = (el: HTMLElement) => { el.getClientRects = () => [{}] as unknown as DOMRectList; return el }
  const make = (role: string) => { const el = document.createElement('div'); el.setAttribute('role', role); return el }

  it('is a sheet or a menu on screen, outside the page itself', () => {
    const host = document.createElement('div')
    document.body.append(host)
    expect(overlayOpen(document)).toBe(false)
    const dialog = shown(make('dialog'))
    host.append(dialog)
    expect(overlayOpen(document)).toBe(true)
    // Its own: not over it.
    expect(overlayOpen(document, host)).toBe(false)
    dialog.remove()
    // A menu that is not laid out (display: none) or sits in a hidden panel covers nothing.
    host.append(make('menu'))
    expect(overlayOpen(document)).toBe(false)
    const panel = document.createElement('div')
    panel.hidden = true
    panel.append(shown(make('menu')))
    host.append(panel)
    expect(overlayOpen(document)).toBe(false)
    host.append(shown(make('menu')))
    expect(overlayOpen(document)).toBe(true)
    // Away from the page (a menu in the sidebar): the page stays.
    const side = shown(make('menu'))
    side.getBoundingClientRect = () => ({ left: 0, top: 100, right: 250, bottom: 300, width: 250, height: 200 }) as DOMRect
    host.replaceChildren(side)
    const page = { left: 290, top: 80, right: 1280, bottom: 660 }
    expect(overlayOpen(document, null, page)).toBe(false)
    side.getBoundingClientRect = () => ({ left: 200, top: 100, right: 450, bottom: 300, width: 250, height: 200 }) as DOMRect
    expect(overlayOpen(document, null, page)).toBe(true)
    // A toast says something; it is no reason to hide the page.
    host.replaceChildren(shown(make('status')))
    expect(overlayOpen(document)).toBe(false)
    host.remove()
  })
})
