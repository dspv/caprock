import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LinkChooser } from './LinkChooser'
import { chooserEntries } from '@/lib/linkchooser'
import type { InstalledBrowser } from '@/lib/api'

// Nothing here opens a browser or touches the clipboard: every opener is a mock.
const URL_ = 'https://github.com/dspv/caprock/pull/1'
const LIST: InstalledBrowser[] = [
  { id: 'firefox', name: 'Firefox', default: false },
  { id: 'chrome', name: 'Google Chrome', default: true },
  { id: 'safari', name: 'Safari', default: false },
]

function setup(over: Partial<Parameters<typeof LinkChooser>[0]> = {}) {
  const calls = { openIn: [] as string[], openDefault: [] as string[], copied: [] as string[], closed: 0 }
  const props = {
    url: URL_,
    at: { x: 40, y: 60 },
    onClose: () => { calls.closed++ },
    load: () => Promise.resolve(LIST),
    openIn: (b: string, u: string) => { calls.openIn.push(`${b}|${u}`); return Promise.resolve() },
    openDefault: (u: string) => { calls.openDefault.push(u) },
    copy: (t: string) => { calls.copied.push(t); return Promise.resolve(true) },
    ...over,
  }
  render(<LinkChooser {...props} />)
  return calls
}

const names = () => screen.getAllByRole('menuitem').map((b) => b.textContent)

afterEach(() => { vi.restoreAllMocks() })

describe('chooserEntries', () => {
  it('puts the default first, then the rest as the daemon sorted them, then Copy link', () => {
    expect(chooserEntries(LIST).map((e) => (e.kind === 'browser' ? e.name : e.kind))).toEqual(['Google Chrome', 'Firefox', 'Safari', 'copy'])
  })
  it('offers the system default when the list is unknown or names none', () => {
    expect(chooserEntries(null).map((e) => e.kind)).toEqual(['system', 'copy'])
    expect(chooserEntries([{ id: 'x', name: 'X', default: false }]).map((e) => e.kind)).toEqual(['system', 'browser', 'copy'])
  })
})

describe('LinkChooser', () => {
  it('lists the browsers, the default first and marked, then Copy link; the first takes focus', async () => {
    setup()
    await waitFor(() => expect(names()).toEqual(['Google Chromedefault', 'Firefox', 'Safari', 'Copy link']))
    expect(screen.getByRole('menu', { name: 'Open link in' })).toBeInTheDocument()
    expect(screen.getByText(URL_)).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByRole('menuitem')[0]).toHaveFocus())
  })

  it('opens the default as ⌘-click does, any other through the daemon', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Google Chrome/ }))
    expect(calls.openDefault).toEqual([URL_])
    expect(calls.openIn).toEqual([])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Firefox' }))
    await waitFor(() => expect(calls.openIn).toEqual([`firefox|${URL_}`]))
    expect(calls.closed).toBe(2)
  })

  it('copies the link', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() => expect(calls.copied).toEqual([URL_]))
    expect(calls.closed).toBe(1)
  })

  it('moves by arrows, picks by Enter, and closes on Escape without opening anything', async () => {
    const calls = setup()
    await waitFor(() => expect(screen.getAllByRole('menuitem')[0]).toHaveFocus())
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Firefox' })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'End' })
    expect(screen.getByRole('menuitem', { name: 'Copy link' })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(calls.closed).toBe(1)
    expect(calls.openIn).toEqual([])
    expect(calls.openDefault).toEqual([])
  })

  it('says so and stays open when a browser fails to open', async () => {
    const calls = setup({ openIn: () => Promise.reject(new Error('it quit')) })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Safari' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Could not open it in Safari: it quit$/)
    expect(calls.closed).toBe(0)
  })

  it('still offers the default and Copy link when the daemon cannot list browsers', async () => {
    const calls = setup({ load: () => Promise.resolve(null) })
    await waitFor(() => expect(names()).toEqual(['Default browserdefault', 'Copy link']))
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /Default browser/ })) })
    expect(calls.openDefault).toEqual([URL_])
  })
})
