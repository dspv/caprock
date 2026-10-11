import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useThemeMode } from './theme'

describe('the theme toggle', () => {
  it('walks Graphite → Paper → White → Graphite', () => {
    localStorage.setItem('caprock-theme', 'dark')
    const { result } = renderHook(() => useThemeMode())
    expect(result.current.mode).toBe('dark')
    act(() => result.current.cycle())
    expect(result.current.mode).toBe('paper')
    expect(document.documentElement.getAttribute('data-tone')).toBe('paper')
    act(() => result.current.cycle())
    expect(result.current.mode).toBe('white')
    act(() => result.current.cycle())
    expect(result.current.mode).toBe('dark')
    expect(result.current.next).toBe('paper')
  })
})
