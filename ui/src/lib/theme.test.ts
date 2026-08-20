import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTheme } from './theme'

describe('useTheme', () => {
  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute('data-theme')
  })

  it('defaults to dark when nothing is saved and OS is not light', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }) as MediaQueryList)
    const { result } = renderHook(() => useTheme())
    expect(result.current[0]).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('follows a light OS preference when nothing is saved', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }) as MediaQueryList)
    const { result } = renderHook(() => useTheme())
    expect(result.current[0]).toBe('light')
  })

  it('honors a saved choice over the OS preference, and toggles + persists', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }) as MediaQueryList)
    localStorage.setItem('caprock-theme', 'dark')
    const { result } = renderHook(() => useTheme())
    expect(result.current[0]).toBe('dark') // saved wins over OS=light
    act(() => result.current[1]())
    expect(result.current[0]).toBe('light')
    expect(localStorage.getItem('caprock-theme')).toBe('light')
  })
})
