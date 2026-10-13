import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadSidebarMode, saveSidebarMode, SIDEBAR_MODE_KEY, useSidebarMode } from './sidebarMode'

beforeEach(() => localStorage.clear())

describe('the sidebar mode', () => {
  // Owner, 2026-10-14: Flat is the default; Tree is a choice.
  it('is Flat by default and for a viewer who chose a flat list; Tree only when chosen', () => {
    expect(loadSidebarMode()).toBe('flat')
    localStorage.setItem(SIDEBAR_MODE_KEY, 'off')
    expect(loadSidebarMode()).toBe('flat')
    localStorage.setItem(SIDEBAR_MODE_KEY, 'on')
    expect(loadSidebarMode()).toBe('tree')
  })

  it('tells every reader at once: Settings and the sidebar never disagree', () => {
    const a = renderHook(() => useSidebarMode())
    const b = renderHook(() => useSidebarMode())
    act(() => a.result.current[1]('tree'))
    expect(b.result.current[0]).toBe('tree')
    expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('on')
    act(() => saveSidebarMode('flat'))
    expect(a.result.current[0]).toBe('flat')
  })
})
