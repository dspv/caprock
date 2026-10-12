import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ThemePicker } from './ThemePicker'

afterEach(() => {
  localStorage.clear()
  for (const a of ['data-theme', 'data-tone', 'data-dark', 'data-glow']) document.documentElement.removeAttribute(a)
})

describe('the theme picker', () => {
  it('groups the eight palettes: Dark, then Light', () => {
    localStorage.setItem('caprock-theme', 'dark')
    render(<ThemePicker />)
    const names = (g: string) => within(screen.getByRole('group', { name: g })).getAllByRole('radio').map((r) => r.textContent?.replace('✓', ''))
    expect(names('Dark')).toEqual(['Dark Warm', 'Dark Cold', 'Dark Pastel', 'Dark Side'])
    expect(names('Light')).toEqual(['Light', 'Light Cold', 'Book', 'Light Side'])
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
    expect(html.getAttribute('data-dark')).toBe('graphite')
    expect(html.hasAttribute('data-glow')).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: /Dark Cold/ }))
    expect(html.getAttribute('data-dark')).toBe('slate')
    expect(localStorage.getItem('caprock-theme-mode')).toBe('dark-cold')
    expect(screen.getByRole('radio', { name: /Dark Cold/ })).toHaveAttribute('aria-checked', 'true')
  })
})
