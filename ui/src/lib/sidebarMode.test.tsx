import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { EXISTING_VIEWER_KEYS, isExistingViewer, loadSidebarMode, saveSidebarMode, SIDEBAR_MODE_KEY, useSidebarMode } from './sidebarMode'

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

  it('starts a new viewer on Flat, and writes it down so the tabs the app keeps next do not change it', () => {
    expect(loadSidebarMode()).toBe('flat')
    expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('off')
    localStorage.setItem('caprock.app.workspace.v1', '{}')
    expect(loadSidebarMode()).toBe('flat')
  })

  // 0.116.0 read a missing key as Flat and moved everyone who never chose.
  it.each(EXISTING_VIEWER_KEYS)('keeps Tree for a viewer who never chose but has %s, and writes it down', (key) => {
    localStorage.setItem(key, 'x')
    expect(isExistingViewer()).toBe(true)
    expect(loadSidebarMode()).toBe('tree')
    expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('on')
  })

  it('does not count unrelated keys as having used the app', () => {
    localStorage.setItem('caprock.update.dismissed', 'offer')
    localStorage.setItem('something-else', '1')
    expect(isExistingViewer()).toBe(false)
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
