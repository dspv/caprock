import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { THEME_MENU_W, ThemeMenu, ThemePicker, nextSwatch, placeThemeMenu } from './ThemePicker'

afterEach(() => {
  localStorage.clear()
  for (const a of ['data-theme', 'data-tone', 'data-dark', 'data-glow']) document.documentElement.removeAttribute(a)
})

describe('the theme picker', () => {
  it('groups the nine palettes: Dark, then Light', () => {
    localStorage.setItem('caprock-theme', 'dark')
    render(<ThemePicker />)
    const names = (g: string) => within(screen.getByRole('group', { name: g })).getAllByRole('radio').map((r) => r.textContent?.replace('✓', ''))
    expect(names('Dark')).toEqual(['Dark Pastel', 'Dark Warm', 'Dark Cold', 'Dark Side'])
    expect(names('Light')).toEqual(['Light', 'Light Cold', 'Book', 'Light Side', 'Sunlight'])
  })

  it('tries a palette on hover, puts the kept one back on leave, and keeps one on click', () => {
    localStorage.setItem('caprock-theme', 'dark')
    render(<ThemePicker />)
    const html = document.documentElement
    fireEvent.mouseEnter(screen.getByRole('radio', { name: /Book/ }))
    expect(html.getAttribute('data-theme')).toBe('light')
    expect(html.getAttribute('data-tone')).toBe('paper')
    fireEvent.mouseEnter(screen.getByRole('radio', { name: /Light Side/ }))
    expect(html.getAttribute('data-tone')).toBe('side')
    expect(html.hasAttribute('data-glow')).toBe(true)
    fireEvent.mouseLeave(screen.getByRole('radiogroup'))
    expect(html.getAttribute('data-theme')).toBe('dark')
    expect(html.getAttribute('data-dark')).toBe('pastel')
    expect(html.hasAttribute('data-glow')).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: /Dark Cold/ }))
    expect(html.getAttribute('data-dark')).toBe('slate')
    expect(localStorage.getItem('caprock-theme-mode')).toBe('dark-cold')
    expect(screen.getByRole('radio', { name: /Dark Cold/ })).toHaveAttribute('aria-checked', 'true')
  })
})

describe('where the theme popover opens', () => {
  const H = 380
  const view = { w: 1280, h: 800 }
  const inside = (p: { left: number; top: number; width: number; maxHeight: number }, v = view) => {
    expect(p.left).toBeGreaterThanOrEqual(8)
    expect(p.top).toBeGreaterThanOrEqual(8)
    expect(p.left + p.width).toBeLessThanOrEqual(v.w - 8)
    expect(p.top + Math.min(H, p.maxHeight)).toBeLessThanOrEqual(v.h - 8)
  }

  it('opens up from the sidebar footer, whole, at the narrowest and widest sidebar', () => {
    // The theme half of the footer's split row: the right half of a 240 and a 320px sidebar.
    for (const btn of [{ left: 124, right: 232, top: 720, bottom: 752 }, { left: 164, right: 312, top: 720, bottom: 752 }]) {
      const p = placeThemeMenu(btn, H, view, 'up', 'right')
      inside(p)
      expect(p.top + H).toBe(btn.top - 6)
      expect(p.width).toBe(THEME_MENU_W)
    }
  })

  it('stays inside the window when the button sits by its left edge, folded', () => {
    // Folded footer: a 36px column near the sidebar's left; right-aligned it would leave the window.
    const btn = { left: 10, right: 46, top: 760, bottom: 792 }
    inside(placeThemeMenu(btn, H, view, 'up', 'right'))
    const p = placeThemeMenu(btn, H, view, 'up', 'left')
    expect(p.left).toBe(10)
    inside(p)
  })

  it('opens down when there is no room above, and the other way round', () => {
    const top = placeThemeMenu({ left: 1200, right: 1220, top: 10, bottom: 30 }, H, view, 'up', 'right')
    expect(top.top).toBe(36)
    inside(top)
    const bottom = placeThemeMenu({ left: 100, right: 200, top: 760, bottom: 792 }, H, view, 'down', 'right')
    expect(bottom.top + H).toBe(754)
    inside(bottom)
  })

  it('fits a window narrower and shorter than itself: capped, scrolling', () => {
    const small = { w: 200, h: 300 }
    const p = placeThemeMenu({ left: 120, right: 190, top: 260, bottom: 290 }, H, small, 'up', 'right')
    expect(p.width).toBe(184)
    expect(p.maxHeight).toBe(284)
    expect(p.left).toBe(8)
    expect(p.top).toBe(8)
  })

  it('renders on <body>, not inside the clipping sidebar, and keeps the keyboard', () => {
    localStorage.setItem('caprock-theme', 'dark')
    localStorage.setItem('caprock-theme-mode', 'dark-cold')
    render(<aside style={{ overflow: 'hidden' }}><ThemeMenu label="Theme: Dark Cold">T</ThemeMenu></aside>)
    const button = screen.getByRole('button', { name: 'Theme: Dark Cold' })
    fireEvent.click(button)
    const menu = screen.getByRole('dialog', { name: 'Theme' })
    expect(menu.parentElement).toBe(document.body)
    expect(menu.closest('aside')).toBeNull()
    expect(menu.className).toContain('fixed')
    // The palette in use has the focus.
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Dark Cold/ }))
    // Esc closes and gives the focus back.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(button)
    // Tab past the last palette closes it too.
    fireEvent.click(button)
    const radios = screen.getAllByRole('radio')
    const last = radios[radios.length - 1]!
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('closes on a click outside, not on a click inside the portalled popover', () => {
    localStorage.setItem('caprock-theme', 'dark')
    render(<ThemeMenu label="Theme">T</ThemeMenu>)
    fireEvent.click(screen.getByRole('button', { name: 'Theme' }))
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens from its key (⌥⌘P) as the same portalled popover, and closes on it again', () => {
    localStorage.setItem('caprock-theme', 'dark')
    localStorage.setItem('caprock-theme-mode', 'dark-cold')
    render(<ThemeMenu label="Theme" openOn="caprock:theme-menu-test">T</ThemeMenu>)
    const button = screen.getByRole('button', { name: 'Theme' })
    act(() => { window.dispatchEvent(new Event('caprock:theme-menu-test')) })
    const menu = screen.getByRole('dialog', { name: 'Theme' })
    expect(menu.parentElement).toBe(document.body)
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Dark Cold/ }))
    act(() => { window.dispatchEvent(new Event('caprock:theme-menu-test')) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('walks the swatches with the arrows as they are laid out, in two columns across the groups', () => {
    // Two columns, 100 wide, 60 tall: a b / c d, then a gap, e f / g.
    const r = (x: number, y: number) => ({ left: x, top: y, width: 100, height: 60, right: x + 100, bottom: y + 60 }) as DOMRect
    const rects = [r(0, 0), r(110, 0), r(0, 70), r(110, 70), r(0, 180), r(110, 180), r(0, 250)]
    expect(nextSwatch(rects.at(0)!, rects, 'ArrowRight')).toBe(1)
    expect(nextSwatch(rects.at(1)!, rects, 'ArrowRight')).toBeNull()
    expect(nextSwatch(rects.at(1)!, rects, 'ArrowDown')).toBe(3)
    expect(nextSwatch(rects.at(3)!, rects, 'ArrowDown')).toBe(5)
    expect(nextSwatch(rects.at(5)!, rects, 'ArrowDown')).toBe(6)
    expect(nextSwatch(rects.at(6)!, rects, 'ArrowUp')).toBe(4)
    expect(nextSwatch(rects.at(0)!, rects, 'ArrowUp')).toBeNull()
    expect(nextSwatch(rects.at(2)!, rects, 'ArrowLeft')).toBeNull()
    expect(nextSwatch(rects.at(0)!, rects, 'Enter')).toBeNull()
  })

  it('moves the focus with an arrow, and the swatch it lands on is previewed on the page', () => {
    localStorage.setItem('caprock-theme', 'dark')
    render(<ThemePicker />)
    const radios = screen.getAllByRole('radio')
    // jsdom lays nothing out: give each swatch a place, two to a row.
    radios.forEach((el, i) => { el.getBoundingClientRect = () => ({ left: (i % 2) * 110, top: Math.floor(i / 2) * 70, width: 100, height: 60, right: (i % 2) * 110 + 100, bottom: Math.floor(i / 2) * 70 + 60, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect })
    const [a, b, , d] = radios as [HTMLElement, HTMLElement, HTMLElement, HTMLElement]
    a.focus()
    fireEvent.keyDown(a, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(b)
    fireEvent.keyDown(b, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(d)
    expect(document.documentElement.getAttribute('data-theme')).not.toBeNull()
  })
})
