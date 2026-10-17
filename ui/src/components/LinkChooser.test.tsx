import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LinkChooser } from './LinkChooser'
import { chooserEntries } from '@/lib/linkchooser'
import type { InstalledBrowser } from '@/lib/api'

// Nothing here opens a browser, a tab or touches the clipboard: every opener is a mock.
const URL_ = 'https://github.com/dspv/caprock/pull/1'
const LIST: InstalledBrowser[] = [
  { id: 'chrome', name: 'Google Chrome', default: true },
  { id: 'firefox', name: 'Firefox', default: false },
  { id: 'safari', name: 'Safari', default: false },
]

function setup(over: Partial<Parameters<typeof LinkChooser>[0]> = {}) {
  const calls = { openIn: [] as string[], openDefault: [] as string[], caprock: [] as string[], copied: [] as string[], closed: 0 }
  const props = {
    url: URL_,
    at: { x: 40, y: 60 },
    onClose: () => { calls.closed++ },
    load: () => Promise.resolve(LIST),
    caprock: true,
    openCaprock: (u: string) => { calls.caprock.push(u); return true },
    openIn: (b: string, u: string) => { calls.openIn.push(`${b}|${u}`); return Promise.resolve() },
    openDefault: (u: string) => { calls.openDefault.push(u) },
    copy: (t: string) => { calls.copied.push(t); return Promise.resolve(true) },
    ...over,
  }
  render(<LinkChooser {...props} />)
  return calls
}

const names = () => screen.getAllByRole('menuitem').map((b) => b.textContent)
const kinds = (l: InstalledBrowser[] | null, o?: Parameters<typeof chooserEntries>[1]) => chooserEntries(l, o).map((e) => (e.kind === 'browser' ? e.name : e.kind))

afterEach(() => { vi.restoreAllMocks() })

describe('chooserEntries', () => {
  it('offers the default, Caprock where it can be, Copy link, then Other browser…', () => {
    expect(kinds(LIST, { caprock: true })).toEqual(['default', 'caprock', 'copy', 'more'])
    expect(chooserEntries(LIST)[0]).toEqual({ kind: 'default', name: 'Google Chrome' })
  })
  it('lists the other browsers in place of Other browser… once expanded', () => {
    expect(kinds(LIST, { caprock: true, expanded: true })).toEqual(['default', 'caprock', 'copy', 'Firefox', 'Safari'])
  })
  it('has no Caprock row where a browser tab cannot exist, and nothing to expand without others', () => {
    expect(kinds(LIST)).toEqual(['default', 'copy', 'more'])
    expect(kinds(null)).toEqual(['default', 'copy'])
    expect(kinds([{ id: 'c', name: 'Chrome', default: true }], { caprock: true })).toEqual(['default', 'caprock', 'copy'])
    expect(chooserEntries([{ id: 'x', name: 'X', default: false }])[0]).toEqual({ kind: 'default' })
  })
})

describe('LinkChooser', () => {
  it('shows the two choices and Copy link, the default named and focused', async () => {
    setup()
    await waitFor(() => expect(names()).toEqual(['Default browserGoogle Chrome', 'Caprock browser', 'Copy link', 'Other browser…']))
    expect(screen.getByRole('menu', { name: 'Open link in' })).toBeInTheDocument()
    expect(screen.getByText(URL_)).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem')[0]).toHaveFocus()
  })

  it('opens the default as ⌘-click does', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Default browser/ }))
    expect(calls.openDefault).toEqual([URL_])
    expect(calls.openIn).toEqual([])
    expect(calls.closed).toBe(1)
  })

  it('opens a Caprock tab', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Caprock browser' }))
    expect(calls.caprock).toEqual([URL_])
    expect(calls.closed).toBe(1)
  })

  it('says so and stays open when no Caprock tab could open', async () => {
    const calls = setup({ openCaprock: () => false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Caprock browser' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/In-app browser \(beta\)/)
    expect(calls.closed).toBe(0)
  })

  it('has no Caprock row outside the desktop app', async () => {
    setup({ caprock: false })
    await waitFor(() => expect(names()).toEqual(['Default browserGoogle Chrome', 'Copy link', 'Other browser…']))
  })

  it('expands Other browser… in place, focuses the first, and opens one through the daemon', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Other browser…' }))
    await waitFor(() => expect(names()).toEqual(['Default browserGoogle Chrome', 'Caprock browser', 'Copy link', 'Firefox', 'Safari']))
    expect(screen.getByRole('menuitem', { name: 'Firefox' })).toHaveFocus()
    expect(calls.closed).toBe(0)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Safari' }))
    await waitFor(() => expect(calls.openIn).toEqual([`safari|${URL_}`]))
    expect(calls.closed).toBe(1)
  })

  it('copies the link', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() => expect(calls.copied).toEqual([URL_]))
    expect(calls.closed).toBe(1)
  })

  it('moves by arrows, picks by Enter, and closes on Escape without opening anything', async () => {
    const calls = setup()
    await waitFor(() => expect(names()).toHaveLength(4))
    expect(screen.getAllByRole('menuitem')[0]).toHaveFocus()
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Caprock browser' })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'End' })
    expect(screen.getByRole('menuitem', { name: 'Other browser…' })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(calls.closed).toBe(1)
    expect(calls.openIn).toEqual([])
    expect(calls.openDefault).toEqual([])
    expect(calls.caprock).toEqual([])
  })

  it('says so and stays open when a browser fails to open', async () => {
    const calls = setup({ openIn: () => Promise.reject(new Error('it quit')) })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Other browser…' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Safari' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Could not open it in Safari: it quit$/)
    expect(calls.closed).toBe(0)
  })

  it('still offers the default and Copy link when the daemon cannot list browsers', async () => {
    const calls = setup({ load: () => Promise.resolve(null), caprock: false })
    await waitFor(() => expect(names()).toEqual(['Default browser', 'Copy link']))
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /Default browser/ })) })
    expect(calls.openDefault).toEqual([URL_])
  })
})
