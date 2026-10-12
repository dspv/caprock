import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useThemeMode } from './theme'

afterEach(() => {
  localStorage.clear()
  for (const a of ['data-theme', 'data-tone', 'data-dark', 'data-glow']) document.documentElement.removeAttribute(a)
})

describe('the theme toggle', () => {
  it('walks all eight, dark ones first, and back to Dark Warm', () => {
    localStorage.setItem('caprock-theme', 'dark')
    const { result } = renderHook(() => useThemeMode())
    const seen = [result.current.mode]
    for (let i = 0; i < 8; i++) {
      act(() => result.current.cycle())
      seen.push(result.current.mode)
    }
    expect(seen).toEqual(['dark-warm', 'dark-cold', 'dark-pastel', 'dark-side', 'light', 'light-cold', 'book', 'light-side', 'dark-warm'])
    expect(result.current.next).toBe('dark-cold')
  })

  it('puts each palette’s attributes on <html> as it goes', () => {
    localStorage.setItem('caprock-theme', 'dark')
    const { result } = renderHook(() => useThemeMode())
    const el = document.documentElement
    act(() => result.current.cycle())
    expect(el.getAttribute('data-dark')).toBe('slate')
    act(() => result.current.cycle())
    expect(el.getAttribute('data-dark')).toBe('pastel')
    act(() => result.current.cycle())
    expect(el.getAttribute('data-dark')).toBe('side')
    act(() => result.current.cycle())
    expect(el.getAttribute('data-theme')).toBe('light')
    expect(el.getAttribute('data-tone')).toBe('white')
    act(() => result.current.cycle())
    expect(el.getAttribute('data-tone')).toBe('cold')
    act(() => result.current.cycle())
    expect(el.getAttribute('data-tone')).toBe('paper')
  })
})
