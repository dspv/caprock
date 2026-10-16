/**
 * Mail from the keyboard: every key in the list is shown somewhere, the `?`
 * sheet lists them all, and t picks a theme without the mouse.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { GO, KeySheet, MAIL_KEYS, SHEET } from './keymap'
import { ThemePick } from './ThemePick'
import { THEMES } from '@/lib/themes'

const press = (key: string) => act(() => { fireEvent.keyDown(window, { key }) })

describe('mail keymap', () => {
  it('lists every key on the ? sheet exactly once', () => {
    const listed = SHEET.flatMap((g) => g.rows.map(([k]) => k))
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort()).toEqual(Object.keys(MAIL_KEYS).sort())
  })

  it('binds a g-key for every folder the sheet names', () => {
    for (const [k, v] of Object.entries(MAIL_KEYS)) {
      if (v.startsWith('g ') && k !== 'sync') expect(GO[v.slice(2)], k).toBeTruthy()
    }
  })

  it('shows the sheet with its keys', () => {
    render(<KeySheet onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy()
    expect(screen.getByText('Move to folder')).toBeTruthy()
  })
})

describe('theme from the keyboard', () => {
  beforeEach(() => { localStorage.clear() })

  it('a digit keeps that theme and closes', () => {
    let closed = false
    render(<ThemePick onClose={() => { closed = true }} />)
    const last = THEMES.length
    press(String(last))
    expect(closed).toBe(true)
    const row = THEMES[last - 1]!
    expect(document.documentElement.getAttribute('data-theme')).toBe(row.theme)
  })

  it('j previews, Esc puts the kept one back', () => {
    render(<ThemePick onClose={() => {}} />)
    const before = document.documentElement.getAttribute('data-theme')
    for (let i = 0; i < THEMES.length; i++) press('j')
    expect(document.documentElement.getAttribute('data-theme')).toBe(THEMES[THEMES.length - 1]!.theme)
    press('Escape')
    expect(document.documentElement.getAttribute('data-theme')).toBe(before)
  })
})
