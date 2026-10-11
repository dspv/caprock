import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ThemePicker } from './ThemePicker'

afterEach(() => {
  localStorage.clear()
  for (const a of ['data-theme', 'data-tone', 'data-dark']) document.documentElement.removeAttribute(a)
})

describe('the theme picker', () => {
  it('tries a palette on hover, puts the kept one back on leave, and keeps one on click', () => {
    localStorage.setItem('caprock-theme', 'dark')
    render(<ThemePicker />)
    const html = document.documentElement
    fireEvent.mouseEnter(screen.getByRole('radio', { name: /Paper/ }))
    expect(html.getAttribute('data-theme')).toBe('light')
    expect(html.getAttribute('data-tone')).toBe('paper')
    fireEvent.mouseLeave(screen.getByRole('radiogroup'))
    expect(html.getAttribute('data-theme')).toBe('dark')
    fireEvent.click(screen.getByRole('radio', { name: /Slate/ }))
    expect(html.getAttribute('data-dark')).toBe('slate')
    expect(localStorage.getItem('caprock-dark-tone')).toBe('slate')
    expect(screen.getByRole('radio', { name: /Slate/ })).toHaveAttribute('aria-checked', 'true')
  })
})
