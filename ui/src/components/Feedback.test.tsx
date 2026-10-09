import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const opened: string[] = []
vi.mock('@/lib/nudges', async (orig) => ({
  ...(await orig<typeof import('@/lib/nudges')>()),
  openExternal: (url: string) => { opened.push(url) },
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, status: () => Promise.reject(new Error('down')) } }
})

import { FeedbackButton } from './Feedback'
import { currentScreen } from '@/lib/feedback'

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
  written = []
  refuse = false
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
afterEach(() => { vi.unstubAllGlobals() })

function openForm(screenName = 'Cost') {
  render(<FeedbackButton screen={screenName} />)
  fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
  return screen.getByRole('dialog', { name: 'Feedback' })
}

/** Owner, 2026-10-10: an 11px grey "feedback" in the header went unnoticed. */
describe('the feedback form', () => {
  it('files a kind, a title and a description through the app’s browser path', () => {
    openForm()
    const create = screen.getByRole('button', { name: 'Create issue' }) as HTMLButtonElement
    expect(create.disabled).toBe(true) // the title is required
    fireEvent.click(screen.getByRole('radio', { name: 'Idea' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Show cost per branch' } })
    fireEvent.change(screen.getByRole('textbox', { name: /Description/ }), { target: { value: 'per git branch' } })
    fireEvent.click(create)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatch(/^https:\/\/github\.com\/dspv\/caprock\/issues\/new\?/)
    const q = params(opened[0]!)
    expect(q.get('title')).toBe('Show cost per branch')
    expect(q.get('labels')).toBe('enhancement')
    expect(q.get('body')).toContain('per git branch')
    expect(q.get('body')).toContain('Screen: Cost')
    // No screenshots: open and close, no attach step.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('leaves the diagnostics out when unticked, and shows them when opened', () => {
    openForm('Lifetime')
    fireEvent.click(screen.getByRole('button', { name: /version, OS/ }))
    expect(screen.getByText('Screen: Lifetime')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include diagnostics' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Blank screen' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create issue' }))
    expect(params(opened[0]!).get('body')).not.toContain('Screen: Lifetime')
  })

  it('takes pasted screenshots up to four, each with a ×', async () => {
    openForm()
    await paste([png('1.png'), png('2.png')])
    expect(screen.getAllByRole('img')).toHaveLength(2)
    await paste([png('3.png'), png('4.png'), png('5.png')])
    expect(screen.getAllByRole('img')).toHaveLength(4)
    expect(screen.getByText(/Up to 4 screenshots/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Add/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove screenshot 2' }))
    expect(screen.getAllByRole('img')).toHaveLength(3)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:shot-2')
    expect(screen.getByRole('button', { name: /Add/ })).toBeTruthy()
  })

  it('takes a dropped screenshot', async () => {
    const dialog = openForm()
    await act(async () => {
      fireEvent.drop(dialog, { dataTransfer: { files: [png('d.png')], types: ['Files'] } })
    })
    expect(screen.getAllByRole('img')).toHaveLength(1)
  })

  it('opens the issue, puts screenshot 1 on the clipboard, and Copy next cycles', async () => {
    openForm()
    const a = png('a.png'); const b = png('b.png')
    await paste([a, b])
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Chart is crooked' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create issue' })) })
    expect(params(opened[0]!).get('body')).toContain('Screenshots: 2 — paste them here')
    expect(written).toEqual([a])
    expect(screen.getByRole('status').textContent).toContain('Screenshot 1 of 2 is on your clipboard')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copy next/ })) })
    expect(written).toEqual([a, b])
    expect(screen.getByRole('status').textContent).toContain('Screenshot 2 of 2')
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Chart is crooked' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create issue' })) })
    expect(opened).toHaveLength(1)
    expect(screen.getByRole('status').textContent).toContain('save the screenshots')
    // Copying again would fail again: only saving is offered.
    expect(screen.queryByRole('button', { name: /Copy next/ })).toBeNull()
    const clicks: string[] = []
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download) })
    fireEvent.click(screen.getByRole('button', { name: 'Save screenshots' }))
    spy.mockRestore()
    expect(clicks).toEqual(['caprock-feedback-1.png', 'caprock-feedback-2.png'])
    expect(screen.getByRole('status').textContent).toContain('Saved to your downloads')
  })

  it('shows no Copy next for a single screenshot', async () => {
    openForm()
    await paste([png('a.png')])
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Chart is crooked' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create issue' })) })
    expect(screen.getByRole('status').textContent).toMatch(/^Your screenshot is on your clipboard — press (⌘V|Ctrl\+V) in the GitHub comment box\.$/)
    expect(screen.queryByRole('button', { name: /Copy next/ })).toBeNull()
  })

  it('closes with its ×, Escape and the backdrop like every dialog', () => {
    render(<FeedbackButton screen="Now" />)
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    const backdrop = screen.getByRole('dialog').parentElement!
    fireEvent.mouseDown(backdrop)
    fireEvent.click(backdrop)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('has an icon form for the app sidebar that names the screen in front', () => {
    render(<FeedbackButton variant="icon" />)
    expect(screen.getByRole('button', { name: 'Send feedback' })).toBeTruthy()
    expect(currentScreen('#/app', true)).toBe('App tabs')
    expect(currentScreen('#/cost', true)).toBe('Cost')
    expect(currentScreen('', false)).toBe('Now')
  })
})
