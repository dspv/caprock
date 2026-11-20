/**
 * The Settings menu's rows as a person meets them on a narrow or a Windows
 * window: a long title is cut with an ellipsis inside the menu, never past
 * its edge, and the tooltip with the whole title is there exactly while the
 * title is cut. What a browser lays out is measured in
 * e2e/settings-windows.spec.ts; here, what the component asks of it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it } from 'vitest'
import { SettingsNav, sectionScrollMargin, type SettingsFrame } from './SettingsNav'
import { useSettingsSearch } from './SettingsSearch'

const TITLES = ['Live activity is a few seconds late', 'Use on your phone', 'Telegram', 'Saved prompts and commands']

function Page({ frame = { top: 16 } }: { frame?: SettingsFrame }) {
  const page = useRef<HTMLDivElement>(null)
  const search = useSettingsSearch(page)
  return (
    <>
      <SettingsNav root={page} search={search} frame={frame} />
      <div ref={page}>
        {TITLES.map((t, i) => <section key={t} id={`s${i}`} data-settings-section={t}><p>body {i}</p></section>)}
      </div>
    </>
  )
}

const row = (title: string) => screen.findByRole('button', { name: title })

/** jsdom lays nothing out: say how wide the label is and how much of it shows. */
function layOut(label: HTMLElement, shown: number, whole: number) {
  Object.defineProperty(label, 'clientWidth', { configurable: true, value: shown })
  Object.defineProperty(label, 'scrollWidth', { configurable: true, value: whole })
}

describe('Settings menu', () => {
  it('lists the sections in one column that may shrink, each title in a label that is cut with an ellipsis', async () => {
    render(<Page />)
    const r = await row('Saved prompts and commands')
    // minmax(0, 1fr): a bare `grid` sized the column to the longest title,
    // and every row grew past the 224px menu.
    expect(r.closest('ul')!.className).toMatch(/(^| )grid-cols-1( |$)/)
    const label = r.querySelector<HTMLElement>('[data-settings-nav-label]')!
    expect(label).toHaveTextContent('Saved prompts and commands')
    expect(label.className).toContain('truncate')
    expect(label.className).toContain('min-w-0')
  })

  it('gives a row its whole title as the tooltip only while the menu cuts it', async () => {
    render(<Page />)
    // Twenty-six characters: the length the old guess said still fits.
    const cut = await row('Saved prompts and commands')
    expect(cut).not.toHaveAttribute('title')
    layOut(cut.querySelector<HTMLElement>('[data-settings-nav-label]')!, 167, 201)
    fireEvent.pointerEnter(cut)
    expect(cut).toHaveAttribute('title', 'Saved prompts and commands')

    const whole = await row('Telegram')
    layOut(whole.querySelector<HTMLElement>('[data-settings-nav-label]')!, 167, 60)
    fireEvent.pointerEnter(whole)
    expect(whole).not.toHaveAttribute('title')
    fireEvent.focus(whole)
    expect(whole).not.toHaveAttribute('title')

    // The menu got wider (or the scrollbar went): the tooltip goes with the cut.
    layOut(cut.querySelector<HTMLElement>('[data-settings-nav-label]')!, 201, 201)
    fireEvent.focus(cut)
    expect(cut).not.toHaveAttribute('title')
  })

  it('does the same for a search result', async () => {
    render(<Page />)
    fireEvent.change(await screen.findAllByLabelText('Search settings').then((f) => f[0]!), { target: { value: 'saved' } })
    const results = await waitFor(() => {
      const ul = document.querySelector<HTMLElement>('[data-settings-results]')
      expect(ul).not.toBeNull()
      return ul!
    })
    expect(results.className).toMatch(/(^| )grid-cols-1( |$)/)
    const r = await waitFor(() => {
      const b = results.querySelector<HTMLElement>('button')
      expect(b).not.toBeNull()
      return b!
    })
    expect(r).not.toHaveAttribute('title')
    layOut(r.querySelector<HTMLElement>('[data-settings-nav-label]')!, 120, 201)
    fireEvent.pointerEnter(r)
    expect(r).toHaveAttribute('title', 'Saved prompts and commands')
  })

  it('is held below the sticky header and no taller than the box the page scrolls in', async () => {
    // The app at 1280px: a 96px header (top 112) in a 671px box under the
    // tab strip. Counted from the window, the menu ran under the status strip.
    const { unmount } = render(<Page frame={{ top: 112, room: 671 }} />)
    await row('Telegram')
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    expect(nav.style.top).toBe('112px')
    expect(nav.style.maxHeight).toBe('535px')
    unmount()
    // A browser: the window scrolls, so the window is the measure.
    render(<Page frame={{ top: 56 }} />)
    await row('Telegram')
    expect(screen.getByRole('navigation', { name: 'Settings sections' }).style.maxHeight).toBe('calc(100vh - 80px)')
  })

  it('a section scrolled to lands below the header, however many rows it wraps to', () => {
    expect(sectionScrollMargin({ top: 16 })).toBe(64)
    expect(sectionScrollMargin({ top: 56 })).toBe(64)
    expect(sectionScrollMargin({ top: 84 })).toBe(84)
    expect(sectionScrollMargin({ top: 140, room: 671 })).toBe(140)
  })
})
