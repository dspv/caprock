import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { DEFAULT_TONE, THEME_COLORS, themeColor, useLightTone, useTheme } from './theme'

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

describe('theme-color', () => {
  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
    document.head.querySelector('meta[name="theme-color"]')?.remove()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-tone')
  })

  it('is the header panel colour of each palette', () => {
    expect(themeColor('dark', 'paper')).toBe(THEME_COLORS.dark)
    expect(themeColor(null, null)).toBe(THEME_COLORS.dark)
    expect(themeColor('light', 'paper')).toBe(THEME_COLORS.paper)
    expect(themeColor('light', null)).toBe(THEME_COLORS.paper)
    expect(themeColor('light', 'white')).toBe(THEME_COLORS.white)
  })

  it('follows a theme switch, so the status bar matches the header', () => {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
    vi.stubGlobal('matchMedia', () => ({ matches: false }) as MediaQueryList)
    const { result } = renderHook(() => useTheme())
    expect(meta.content).toBe(THEME_COLORS.dark)
    document.documentElement.setAttribute('data-tone', 'paper')
    act(() => result.current[2]('light'))
    expect(meta.content).toBe(THEME_COLORS.paper)
  })
})
