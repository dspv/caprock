import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal as Xterm } from '@xterm/xterm'

const h = vi.hoisted(() => ({ paths: [] as string[] }))
vi.mock('@/lib/api', () => ({
  api: { paste: vi.fn(async () => ({ path: h.paths.shift() ?? '' })) },
  errText: (e: Error) => e.message,
}))

import { DROP_PATHS_EVENT, routeDrop, attachTerminalInput, isImagePath, pathInput } from './xtermInput'

const SPACED = '/Users/u/Library/Application Support/caprock/paste/20261011-ab/image.png'

function setup(bracketedPasteMode: boolean) {
  const sent: string[] = []
  const term = {
    modes: { bracketedPasteMode },
    attachCustomKeyEventHandler: () => {},
    getSelection: () => '',
    clearSelection: () => {},
    write: () => {},
    focus: () => {},
  } as unknown as Xterm
  const el = document.createElement('div')
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect
  document.body.appendChild(el)
  const input = attachTerminalInput(term, el, (d) => sent.push(d))
  return { sent, el, input }
}

const file = (name: string, type: string) =>
  ({ name, type, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) as unknown as File

afterEach(() => {
  document.body.innerHTML = ''
  h.paths = []
})

describe('pathInput', () => {
  it('pastes an image as its own bracketed paste of the quoted path, no trailing space', () => {
    expect(pathInput(SPACED, true)).toBe(`\x1b[200~"${SPACED}"\x1b[201~`)
    expect(pathInput('/a/B.JPEG', true)).toBe('\x1b[200~"/a/B.JPEG"\x1b[201~')
  })
  it('types anything else quoted with a space, as before', () => {
    expect(pathInput('/a/notes.md', true)).toBe('"/a/notes.md" ')
    expect(pathInput('/a/folder', true)).toBe('"/a/folder" ')
  })
  it('types an image too when the process never asked for bracketed paste', () => {
    expect(pathInput(SPACED, false)).toBe(`"${SPACED}" `)
  })
  it('knows the image types Claude Code reads', () => {
    for (const p of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'A.PNG']) expect(isImagePath(p)).toBe(true)
    for (const p of ['a.svg', 'a.heic', 'a.pdf', 'png', 'a.png.txt']) expect(isImagePath(p)).toBe(false)
  })
})

describe('attachTerminalInput', () => {
  it('a pasted image upload becomes a bracketed paste, a document stays typed', async () => {
    const { sent, input } = setup(true)
    h.paths = [SPACED, '/d/paste/x/notes.md']
    await input.sendFiles([file('image.png', 'image/png'), file('notes.md', '')])
    expect(sent).toEqual([`\x1b[200~"${SPACED}"\x1b[201~`, '"/d/paste/x/notes.md" '])
  })

  it('the phone photo path (sendFiles) and a shell without bracketed paste type the path', async () => {
    const { sent, input } = setup(false)
    h.paths = [SPACED]
    await input.sendFiles([file('photo.jpg', 'image/jpeg')])
    expect(sent).toEqual([`"${SPACED}" `])
  })

  it('the app native drop pastes each image separately and in order', async () => {
    const { sent, input } = setup(true)
    window.dispatchEvent(new CustomEvent(DROP_PATHS_EVENT, {
      detail: { paths: ['/p/a b.png', '/p/doc.pdf', '/p/c.webp'], x: 10, y: 10 },
    }))
    await input.sendFiles([])  // waits for the queue the drop joined
    expect(sent).toEqual([
      '\x1b[200~"/p/a b.png"\x1b[201~',
      '"/p/doc.pdf" ',
      '\x1b[200~"/p/c.webp"\x1b[201~',
    ])
  })
})


afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

function fakeTerm(selection: string) {
  let handler: (e: KeyboardEvent) => boolean = () => true
  const host = document.createElement('div')
  const el = document.createElement('div')
  host.appendChild(el)
  document.body.appendChild(host)
  const term = {
    element: el,
    getSelection: () => selection,
    clearSelection: vi.fn(),
    attachCustomKeyEventHandler: (h: (e: KeyboardEvent) => boolean) => { handler = h },
    onData: () => ({ dispose() {} }),
    textarea: undefined,
  } as unknown as Xterm
  return { term, el, host, press: (init: KeyboardEventInit) => { const e = new KeyboardEvent('keydown', { cancelable: true, ...init }); return { ret: handler(e), e } } }
}

describe('copy from the terminal', () => {
  it('copies Cmd+C by the physical key on any layout, says so, and keeps the browser from beeping', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel', clipboard: { writeText: vi.fn(() => Promise.resolve()) } })
    const t = fakeTerm('hello')
    attachTerminalInput(t.term, t.el, () => {})
    // A non-Latin layout reports another letter for the C key (Greek: ψ).
    const { ret, e } = t.press({ key: 'ψ', code: 'KeyC', metaKey: true })
    expect(ret).toBe(false)
    expect(e.defaultPrevented).toBe(true)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello')
    await Promise.resolve(); await Promise.resolve()
    expect(t.host.querySelector('[data-copied]')?.textContent).toBe('Copied · 5 chars')
  })

  it('lets Cmd+C through when nothing is selected', () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel', clipboard: { writeText: vi.fn(() => Promise.resolve()) } })
    const t = fakeTerm('')
    attachTerminalInput(t.term, t.el, () => {})
    expect(t.press({ key: 'c', code: 'KeyC', metaKey: true }).ret).toBe(true)
  })
})


describe('routeDrop', () => {
  const box = (left: number, top: number, w: number, h: number) => {
    const el = document.createElement('div')
    el.getBoundingClientRect = () => ({ left, top, right: left + w, bottom: top + h, width: w, height: h }) as DOMRect
    document.body.appendChild(el)
    return el
  }
  const t = (el: HTMLElement, used = 0) => ({ el, used, deliver: () => {} })

  it('picks the terminal under the point', () => {
    const a = t(box(0, 0, 100, 100)), b = t(box(100, 0, 100, 100))
    expect(routeDrop({ paths: ['/x'], x: 150, y: 10 }, [a, b])).toBe(b)
  })
  it('off every terminal, picks the one used last, then the only one on screen', () => {
    const a = t(box(0, 0, 100, 100), 5), b = t(box(100, 0, 100, 100), 9)
    expect(routeDrop({ paths: ['/x'], x: 500, y: 500 }, [a, b])).toBe(b)
    const only = t(box(0, 0, 100, 100))
    const hidden = t(box(0, 0, 0, 0))
    expect(routeDrop({ paths: ['/x'], x: 500, y: 500 }, [only, hidden])).toBe(only)
  })
  it('gives up (so a note is shown) with two unused terminals and the point on neither', () => {
    const a = t(box(0, 0, 100, 100)), b = t(box(100, 0, 100, 100))
    expect(routeDrop({ paths: ['/x'], x: 500, y: 500 }, [a, b])).toBeNull()
  })
  it('leaves it to a dialog on screen, and ignores a terminal taken off the page', () => {
    const gone = box(0, 0, 100, 100)
    const g = t(gone)
    gone.remove()
    expect(routeDrop({ paths: ['/x'], x: 10, y: 10 }, [g])).toBeNull()
    const d = document.createElement('div')
    d.setAttribute('data-dialog-backdrop', '')
    document.body.appendChild(d)
    expect(routeDrop({ paths: ['/x'], x: 10, y: 10 }, [t(box(0, 0, 100, 100))])).toBe('dialog')
  })
})
