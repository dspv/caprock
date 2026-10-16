import { describe, expect, it } from 'vitest'
import { canShowInTab, isLocalUrl, looksLikeAddress, newPageKey, overlayOpen, pageId, pageTitle, pageUrl, rectOf, sameRect } from './pagetab'

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

describe('where a page can show', () => {
  it('shows any web page in the app', () => {
    expect(canShowInTab('https://github.com/', true)).toBe(true)
    expect(canShowInTab('http://localhost:5173/', true)).toBe(true)
    expect(canShowInTab('file:///etc/hosts', true)).toBe(false)
  })

  it('shows only this machine in a browser, and never the dashboard itself', () => {
    const self = 'http://127.0.0.1:4173'
    expect(canShowInTab('http://localhost:5173/', false, self)).toBe(true)
    expect(canShowInTab('http://127.0.0.1:3000/x', false, self)).toBe(true)
    expect(canShowInTab('http://[::1]:8000/', false, self)).toBe(true)
    expect(canShowInTab('https://github.com/', false, self)).toBe(false)
    expect(canShowInTab('http://127.0.0.1:4173/#/app', false, self)).toBe(false)
  })

  it('knows this machine by name and address', () => {
    expect(isLocalUrl('http://localhost:1/')).toBe(true)
    expect(isLocalUrl('http://127.4.5.6/')).toBe(true)
    expect(isLocalUrl('http://web.localhost/')).toBe(true)
    expect(isLocalUrl('http://localhost.example.com/')).toBe(false)
    expect(isLocalUrl('http://192.168.1.5/')).toBe(false)
  })
})

describe('a page tab', () => {
  it('is named by its title, else its host', () => {
    expect(pageTitle('http://localhost:5173/x', '  ')).toBe('localhost:5173')
    expect(pageTitle('https://example.com/', 'Example Domain')).toBe('Example Domain')
  })

  it('has a key the shell takes as a webview label', () => {
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
