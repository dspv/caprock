import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useHideOnScroll } from './phone'

function scroller(): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

function scrollTo(el: HTMLElement, top: number, byReader = true) {
  if (byReader) el.dispatchEvent(new Event('touchmove'))
  el.scrollTop = top
  el.dispatchEvent(new Event('scroll'))
}

describe('useHideOnScroll', () => {
  it('hides on the reader scrolling down, shows on up and at the top', () => {
    const el = scroller()
    const { result } = renderHook(() => useHideOnScroll(el, true, 44))
    expect(result.current[0]).toBe(false)
    act(() => scrollTo(el, 300))
    expect(result.current[0]).toBe(true)
    act(() => scrollTo(el, 250))
    expect(result.current[0]).toBe(false)
    act(() => scrollTo(el, 600))
    expect(result.current[0]).toBe(true)
    // Back near the top: always shown.
    act(() => scrollTo(el, 10))
    expect(result.current[0]).toBe(false)
  })

  it('ignores scrolling the reader did not do: the chat following an answer', () => {
    const el = scroller()
    const { result } = renderHook(() => useHideOnScroll(el, true, 44))
    act(() => scrollTo(el, 800, false))
    expect(result.current[0]).toBe(false)
  })

  it('ignores a jitter under the slack, and a tap brings the bar back', () => {
    const el = scroller()
    const { result } = renderHook(() => useHideOnScroll(el, true, 44))
    act(() => scrollTo(el, 300))
    act(() => scrollTo(el, 297))
    expect(result.current[0]).toBe(true)
    act(() => result.current[1]())
    expect(result.current[0]).toBe(false)
  })

  it('stays shown when off', () => {
    const el = scroller()
    const { result } = renderHook(() => useHideOnScroll(el, false, 44))
    act(() => scrollTo(el, 300))
    expect(result.current[0]).toBe(false)
  })
})
