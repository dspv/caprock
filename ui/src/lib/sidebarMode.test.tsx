import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadSidebarMode, saveSidebarMode, SIDEBAR_MODE_KEY, useSidebarMode } from './sidebarMode'

beforeEach(() => localStorage.clear())

describe('the sidebar mode', () => {
  it('keeps what was chosen, whatever else this browser holds', () => {
    localStorage.setItem('caprock.app.workspace.v1', '{}')
    localStorage.setItem(SIDEBAR_MODE_KEY, 'off')
    expect(loadSidebarMode()).toBe('flat')
    localStorage.clear()
    localStorage.setItem(SIDEBAR_MODE_KEY, 'on')
    expect(loadSidebarMode()).toBe('tree')
  })

  // Since 2026-11-05 (mockup V1) Open lists the tabs for everyone, and a
  // viewer who never chose gets the projects under it.
  it('starts a viewer who never chose on Tree, and writes it down', () => {
    expect(loadSidebarMode()).toBe('tree')
    expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('on')
    localStorage.setItem('caprock.app.workspace.v1', '{}')
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
