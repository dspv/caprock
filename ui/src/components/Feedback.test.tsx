import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const opened: string[] = []
const browser = vi.hoisted(() => ({ broken: false }))
vi.mock('@/lib/nudges', async (orig) => ({
  ...(await orig<typeof import('@/lib/nudges')>()),
  openExternal: (url: string) => {
    if (browser.broken) throw new Error('no browser')
    opened.push(url)
  },
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, status: () => Promise.reject(new Error('down')) } }
})

// The desktop app's shell, switched on per test: its clipboard, its window
// capture and its reader for dropped files (app/src-tauri/src/capture.rs).
const native = vi.hoisted(() => ({
  tauri: false,
  capture: false,
  clip: [] as Uint8Array[],
  captured: 0,
  release: null as null | (() => void),
  readable: {} as Record<string, Uint8Array>,
}))
vi.mock('@/lib/appmode', async (orig) => ({
  ...(await orig<typeof import('@/lib/appmode')>()),
  isTauri: () => native.tauri,
}))
vi.mock('@/lib/shell', async (orig) => {
  const actual = await orig<typeof import('@/lib/shell')>()
  return {
    ...actual,
    captureSupported: () => native.capture,
    shell: {
      ...actual.shell,
      clipboardImage: async (b: Uint8Array) => { native.clip.push(b) },
      captureWindow: () => new Promise<ArrayBuffer>((resolve) => {
        native.release = () => { native.captured++; resolve(new Uint8Array([137, 80, 78, 71]).buffer) }
      }),
      readDroppedImage: async (path: string) => {
        const b = native.readable[path]
        if (!b) throw new Error('over 10 MB')
        return b.buffer
      },
    },
  }
})

import { DRAFT_KEY, FeedbackButton, THANKS_MS } from './Feedback'
import { currentScreen } from '@/lib/feedback'
import { DROP_PATHS_EVENT } from '@/lib/xtermInput'

const params = (u: string) => new URL(u).searchParams
const png = (name: string) => new File([new Uint8Array(8)], name, { type: 'image/png' })

/** A paste of image files, as the browser delivers ⌘V of a screenshot. */
async function paste(files: File[]) {
  const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
  ev.clipboardData = { files, items: [] }
  await act(async () => { document.dispatchEvent(ev) })
}

let written: Blob[]
let refuse: boolean

beforeEach(() => {
  opened.length = 0
  browser.broken = false
  native.tauri = false
  native.capture = false
  native.clip = []
  native.captured = 0
  native.release = null
  native.readable = {}
  written = []
  refuse = false
  try { localStorage.removeItem(DRAFT_KEY) } catch { /* none */ }
  let n = 0
  URL.createObjectURL = vi.fn(() => `blob:shot-${++n}`)
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal('ClipboardItem', class { constructor(public data: Record<string, Blob>) {} })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: vi.fn(async (items: { data: Record<string, Blob> }[]) => {
        if (refuse) throw new Error('NotAllowedError')
        written.push(items[0]!.data['image/png']!)
      }),
    },
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

function openForm(screenName = 'Cost') {
  render(<FeedbackButton screen={screenName} />)
  fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
  return screen.getByRole('dialog', { name: 'Feedback' })
}
const box = () => screen.getByRole('textbox', { name: "What's wrong?" }) as HTMLTextAreaElement
const sendButton = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement

/** Owner, 2026-10-16: "just type what's wrong, maybe drop a screenshot, and send". */
describe('the feedback box', () => {
  it('is one focused box and Send, with everything else behind Details', () => {
    openForm()
    expect(document.activeElement).toBe(box())
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(sendButton().disabled).toBe(true)
    expect(screen.getByText(/Opens a GitHub issue in your browser/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Bug', 'Idea', 'Question'])
    expect(screen.getByRole('checkbox', { name: 'Include diagnostics' })).toBeTruthy()
    expect(screen.getByText('Screen: Cost')).toBeTruthy()
  })

  it('types and sends: the first line is the title, then thanks, then it closes', () => {
    vi.useFakeTimers()
    openForm()
    fireEvent.change(box(), { target: { value: 'History is blank\nafter a restart' } })
    fireEvent.click(sendButton())
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatch(/^https:\/\/github\.com\/dspv\/caprock\/issues\/new\?/)
    const q = params(opened[0]!)
    expect(q.get('title')).toBe('History is blank')
    expect(q.get('labels')).toBe('bug')
    expect(q.get('body')).toContain('after a restart')
    expect(q.get('body')).toContain('Screen: Cost')
    expect(screen.getByRole('status').textContent).toBe('Opened on GitHub — thanks')
    act(() => { vi.advanceTimersByTime(THANKS_MS) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('sends with ⌘↩ on macOS, and never on a bare Enter', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    openForm()
    expect(sendButton().querySelector('kbd')?.textContent).toBe('⌘↩')
    fireEvent.change(box(), { target: { value: 'What is session total' } })
    fireEvent.keyDown(box(), { key: 'Enter', code: 'Enter' })
    expect(opened).toHaveLength(0)
    fireEvent.keyDown(box(), { key: 'Enter', code: 'Enter', metaKey: true })
    expect(opened).toHaveLength(1)
  })

  it('sends with Ctrl+Enter on Windows and Linux, labelled that way', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    openForm()
    expect(sendButton().getAttribute('aria-keyshortcuts')).toBe('Control+Enter')
    expect(sendButton().querySelector('kbd')?.textContent).toBe('Ctrl+Enter')
    fireEvent.change(box(), { target: { value: 'Cost per branch' } })
    fireEvent.keyDown(box(), { key: 'Enter', code: 'Enter', ctrlKey: true })
    expect(opened).toHaveLength(1)
  })

  it('takes the kind and leaves the diagnostics out from Details', () => {
    openForm('Lifetime')
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Idea' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include diagnostics' }))
    fireEvent.change(box(), { target: { value: 'Show cost per branch' } })
    fireEvent.click(sendButton())
    expect(params(opened[0]!).get('labels')).toBe('enhancement')
    expect(params(opened[0]!).get('body')).not.toContain('Screen: Lifetime')
  })

  it('keeps the draft after Escape, and forgets it once sent', () => {
    vi.useFakeTimers()
    openForm()
    fireEvent.change(box(), { target: { value: 'The chart is crooked' } })
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    expect(box().value).toBe('The chart is crooked')
    fireEvent.click(sendButton())
    act(() => { vi.advanceTimersByTime(THANKS_MS) })
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    expect(box().value).toBe('')
  })

  it('keeps the words and offers Retry when the browser cannot be opened', () => {
    browser.broken = true
    openForm()
    fireEvent.change(box(), { target: { value: 'Blank screen' } })
    fireEvent.click(sendButton())
    expect(screen.getByRole('alert').textContent).toContain('Your words are kept')
    expect(box().value).toBe('Blank screen')
    browser.broken = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(opened).toHaveLength(1)
  })

  it('takes pasted screenshots up to four, each with a ×', async () => {
    openForm()
    await paste([png('1.png'), png('2.png')])
    expect(screen.getAllByRole('img')).toHaveLength(2)
    await paste([png('3.png'), png('4.png'), png('5.png')])
    expect(screen.getAllByRole('img')).toHaveLength(4)
    expect(screen.getByText(/Up to 4 screenshots/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove screenshot 2' }))
    expect(screen.getAllByRole('img')).toHaveLength(3)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:shot-2')
  })

  it('takes a screenshot dropped anywhere on the sheet, and sends it alone', async () => {
    const dialog = openForm()
    await act(async () => {
      fireEvent.dragOver(dialog, { dataTransfer: { files: [], types: ['Files'] } })
    })
    expect(screen.getByText('Drop to attach')).toBeTruthy()
    await act(async () => {
      fireEvent.drop(dialog, { dataTransfer: { files: [png('d.png')], types: ['Files'] } })
    })
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(sendButton().disabled).toBe(false) // a screenshot alone is a report
    await act(async () => { fireEvent.click(sendButton()) })
    expect(params(opened[0]!).get('title')).toBe('Screenshot from Cost')
  })

  it('opens the issue, puts screenshot 1 on the clipboard, and Copy next cycles', async () => {
    openForm()
    const a = png('a.png'); const b = png('b.png')
    await paste([a, b])
    fireEvent.change(box(), { target: { value: 'Chart is crooked' } })
    await act(async () => { fireEvent.click(sendButton()) })
    expect(params(opened[0]!).get('body')).toContain('Screenshots: 2 — paste them here')
    expect(written).toEqual([a])
    expect(screen.getByRole('status').textContent).toContain('Screenshot 1 of 2 is on your clipboard')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copy next/ })) })
    expect(written).toEqual([a, b])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copy next/ })) })
    expect(written).toEqual([a, b, a])

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opened).toHaveLength(1)
  })

  it('offers saving the screenshots when the clipboard refuses, never a dead end', async () => {
    refuse = true
    openForm()
    await paste([png('a.png'), png('b.png')])
    fireEvent.change(box(), { target: { value: 'Chart is crooked' } })
    await act(async () => { fireEvent.click(sendButton()) })
    expect(screen.getByRole('status').textContent).toContain('save the screenshots')
    expect(screen.queryByRole('button', { name: /Copy next/ })).toBeNull()
    const clicks: string[] = []
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download) })
    fireEvent.click(screen.getByRole('button', { name: 'Save screenshots' }))
    spy.mockRestore()
    expect(clicks).toEqual(['caprock-feedback-1.png', 'caprock-feedback-2.png'])
  })

  it('closes with its ×, Escape and the backdrop like every dialog', () => {
    render(<FeedbackButton screen="Now" />)
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    const backdrop = screen.getByRole('dialog').parentElement!
    fireEvent.mouseDown(backdrop)
    fireEvent.click(backdrop)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('has a labelled row for the app sidebar that names the screen in front', () => {
    render(<FeedbackButton variant="row" />)
    const row = screen.getByRole('button', { name: 'Send feedback' })
    expect(row.textContent).toContain('Send feedback')
    expect(currentScreen('#/app', true)).toBe('App tabs')
    expect(currentScreen('#/cost', true)).toBe('Cost')
    expect(currentScreen('', false)).toBe('Home')
  })
})

describe('the feedback box in the desktop app', () => {
  it('puts the screenshot on the clipboard through the shell, not the webview', async () => {
    native.tauri = true
    openForm()
    await paste([png('a.png')])
    fireEvent.change(box(), { target: { value: 'Chart is crooked' } })
    await act(async () => { fireEvent.click(sendButton()) })
    expect(native.clip).toHaveLength(1)
    expect(written).toEqual([])
    expect(screen.getByRole('status').textContent).toContain('is on your clipboard')
  })

  it('offers Capture window under Details only where the shell can, hidden while it captures', async () => {
    openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.queryByRole('button', { name: 'Capture window' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    native.tauri = true
    native.capture = true
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Capture window' }))
    const backdrop = document.querySelector('[data-dialog-backdrop]')!
    expect(backdrop.className).toContain('invisible')
    await vi.waitFor(() => expect(native.release).not.toBeNull())
    await act(async () => { native.release!() })
    await vi.waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(1))
    expect(native.captured).toBe(1)
    expect(backdrop.className).not.toContain('invisible')
  })

  it('attaches an image dropped on the window (the drop-paths event), and leaves out anything else with a note', async () => {
    native.tauri = true
    native.readable = { '/Users/me/Desktop/shot.PNG': new Uint8Array([1, 2, 3]) }
    openForm()
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DROP_PATHS_EVENT, {
        detail: { paths: ['/Users/me/Desktop/shot.PNG', '/Users/me/notes.txt'], x: 10, y: 10 },
      }))
    })
    await vi.waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(1))
    expect(screen.getByRole('status').textContent).toContain('Only images can be attached.')

    await act(async () => {
      window.dispatchEvent(new CustomEvent(DROP_PATHS_EVENT, { detail: { paths: ['C:\\big.jpg'], x: 10, y: 10 } }))
    })
    await vi.waitFor(() => expect(screen.getByRole('status').textContent).toContain('over 10 MB'))
    expect(screen.getAllByRole('img')).toHaveLength(1)
  })
})
