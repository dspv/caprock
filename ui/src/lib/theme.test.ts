import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { DEFAULT_TONE, useLightTone, useTheme } from './theme'

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

describe('useLightTone', () => {
  afterEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-tone')
  })

  it('uses the default and saves nothing until the user chooses', () => {
    const { result } = renderHook(() => useLightTone())
    expect(result.current[0]).toBe(DEFAULT_TONE)
    expect(document.documentElement.getAttribute('data-tone')).toBe(DEFAULT_TONE)
    expect(localStorage.getItem('caprock-light-tone')).toBeNull()
  })

  it('persists a choice and applies it', () => {
    const { result } = renderHook(() => useLightTone())
    act(() => result.current[1]('white'))
    expect(result.current[0]).toBe('white')
    expect(localStorage.getItem('caprock-light-tone')).toBe('white')
    expect(document.documentElement.getAttribute('data-tone')).toBe('white')
  })
})
