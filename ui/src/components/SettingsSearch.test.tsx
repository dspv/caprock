/**
 * The Settings search as a person uses it: typing hides the sections it does
 * not find, a query that finds nothing says so, Esc clears, and ⌘F — the
 * app's Find, Ctrl+Shift+F off macOS, or plain Ctrl+F there — puts the cursor
 * in the field.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Section } from './SettingsParts'
import { NothingMatches, SettingsFilterContext, SettingsSearchField, useFindKey, useSettingsSearch, useShownIds } from './SettingsSearch'
import { SETTINGS_FIND_EVENT } from '@/lib/settingsSearch'

const m = vi.hoisted(() => ({ mac: true }))
vi.mock('@/lib/appmode', async (orig) => ({ ...(await orig<typeof import('@/lib/appmode')>()), isMacPlatform: () => m.mac }))

function Page() {
  const page = useRef<HTMLDivElement>(null)
  const search = useSettingsSearch(page)
  useFindKey(() => document.querySelector<HTMLInputElement>('input[data-settings-search]')?.focus())
  return (
    <SettingsFilterContext.Provider value={useShownIds(search)}>
      <SettingsSearchField search={search} />
      {search.query.trim() && search.matches.length === 0 && <NothingMatches query={search.query} />}
      <div ref={page}>
        <Section title="Telegram"><p>Paste the bot token</p></Section>
        <Section title="Appearance"><p>Sidebar</p></Section>
        <Section title="Global shortcut"><p>Bring Caprock to the front</p></Section>
      </div>
    </SettingsFilterContext.Provider>
  )
}

const shown = () => [...document.querySelectorAll<HTMLElement>('[data-settings-section]')].filter((s) => !s.hidden).map((s) => s.dataset.settingsSection)

afterEach(() => { m.mac = true })

describe('Settings search', () => {
  it('filters the sections live, by synonym and by text inside, and says when nothing matches', async () => {
    render(<Page />)
    const field = screen.getByLabelText('Search settings')
    fireEvent.change(field, { target: { value: 'dark' } })
    await waitFor(() => expect(shown()).toEqual(['Appearance']))
    fireEvent.change(field, { target: { value: 'token' } })
    await waitFor(() => expect(shown()).toEqual(['Telegram']))
    fireEvent.change(field, { target: { value: 'front' } })
    await waitFor(() => expect(shown()).toEqual(['Global shortcut']))
    fireEvent.change(field, { target: { value: 'zzqx' } })
    expect(await screen.findByText('Nothing matches “zzqx”')).toBeInTheDocument()
    expect(shown()).toEqual([])
  })

  it('Esc clears the query and every section comes back', async () => {
    render(<Page />)
    const field = screen.getByLabelText('Search settings')
    fireEvent.change(field, { target: { value: 'dark' } })
    await waitFor(() => expect(shown()).toEqual(['Appearance']))
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(field).toHaveValue('')
    expect(shown()).toEqual(['Telegram', 'Appearance', 'Global shortcut'])
  })

  it('shows its key through keys(): ⌘F on a Mac, Ctrl+Shift+F elsewhere', () => {
    const { unmount } = render(<Page />)
    expect(screen.getByText('⌘F')).toBeInTheDocument()
    unmount()
    m.mac = false
    render(<Page />)
    expect(screen.getByText('Ctrl+Shift+F')).toBeInTheDocument()
  })

  // The first run on a Windows PC (2026-11-20): Ctrl+Shift+F, twelve
  // characters where a Mac has two, was drawn over "Search settings" in the
  // 224px menu. The key is drawn only where the field is wide enough for
  // both (a container query on the field; e2e/settings-windows.spec.ts
  // measures it in a browser), and the field's tooltip always names it.
  it('draws the key only where the field has room beside the placeholder, and names it in the tooltip', () => {
    const { unmount } = render(<Page />)
    const field = () => screen.getByLabelText('Search settings')
    const box = () => field().parentElement!
    expect(box().className).toContain('@container')
    expect(field()).toHaveAttribute('title', 'Search settings (⌘F)')
    const macKey = screen.getByText('⌘F')
    expect(macKey.className).toMatch(/(^| )hidden( |$)/)
    expect(macKey.className).toContain('@[11rem]:block')
    unmount()
    m.mac = false
    render(<Page />)
    expect(field()).toHaveAttribute('title', 'Search settings (Ctrl+Shift+F)')
    const key = screen.getByText('Ctrl+Shift+F')
    expect(key.className).toMatch(/(^| )hidden( |$)/)
    // 17rem: the icon (32px), the placeholder (102px), the key (100px) and
    // their gaps come to 250px; the menu's field is 224px, so not there.
    expect(key.className).toContain('@[17rem]:block')
    expect(key.className).toContain('whitespace-nowrap')
  })

  it('⌘F on macOS puts the cursor in the field', () => {
    render(<Page />)
    fireEvent.keyDown(window, { key: 'f', code: 'KeyF', metaKey: true })
    expect(screen.getByLabelText('Search settings')).toHaveFocus()
  })

  it('Ctrl+Shift+F and plain Ctrl+F do it on Windows and Linux; Ctrl+Alt+Shift+F (feedback) does not', () => {
    m.mac = false
    render(<Page />)
    const field = screen.getByLabelText('Search settings')
    fireEvent.keyDown(window, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true, altKey: true })
    expect(field).not.toHaveFocus()
    fireEvent.keyDown(window, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true })
    expect(field).toHaveFocus()
    field.blur()
    fireEvent.keyDown(window, { key: 'f', code: 'KeyF', ctrlKey: true })
    expect(field).toHaveFocus()
  })

  it('in the app the shell holds ⌘F and sends the find event', () => {
    render(<Page />)
    act(() => { window.dispatchEvent(new Event(SETTINGS_FIND_EVENT)) })
    expect(screen.getByLabelText('Search settings')).toHaveFocus()
  })
})
