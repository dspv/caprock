import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TerminalSettings } from './TerminalSettings'
import { DEFAULT_PREFS, getTerminalPrefs, setTerminalPrefs } from '@/lib/termprefs'

afterEach(() => setTerminalPrefs(DEFAULT_PREFS))

describe('Settings → Terminal (F21)', () => {
  it('previews and saves each choice at once, and resets', () => {
    render(<TerminalSettings />)
    const preview = screen.getByTestId('terminal-preview')
    expect(preview.style.background).toBe('rgb(33, 31, 29)')
    fireEvent.click(screen.getByRole('radio', { name: 'Catppuccin Mocha' }))
    expect(getTerminalPrefs().theme).toBe('catppuccin-mocha')
    expect(preview.style.background).toBe('rgb(30, 30, 46)')
    fireEvent.click(screen.getByRole('radio', { name: 'Block' }))
    expect(getTerminalPrefs().cursor).toBe('block')
    fireEvent.change(screen.getByRole('slider', { name: /Size/ }), { target: { value: '16' } })
    expect(getTerminalPrefs().fontSize).toBe(16)
    expect(preview.style.fontSize).toBe('16px')
    fireEvent.click(screen.getByRole('button', { name: 'Reset to the defaults' }))
    expect(getTerminalPrefs()).toEqual(DEFAULT_PREFS)
  })

  it('always offers the bundled face', () => {
    render(<TerminalSettings />)
    expect(screen.getByRole('radio', { name: 'JetBrains Mono' })).toHaveAttribute('aria-checked', 'true')
  })
})
