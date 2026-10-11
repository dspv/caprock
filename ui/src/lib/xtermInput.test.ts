import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal as Xterm } from '@xterm/xterm'

const h = vi.hoisted(() => ({ paths: [] as string[] }))
vi.mock('@/lib/api', () => ({
  api: { paste: vi.fn(async () => ({ path: h.paths.shift() ?? '' })) },
  errText: (e: Error) => e.message,
}))

import { DROP_PATHS_EVENT, attachTerminalInput, isImagePath, pathInput } from './xtermInput'

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
