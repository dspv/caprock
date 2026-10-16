import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { BrainGraph } from '@/lib/api'
import { BrainGraphCanvas } from './BrainGraphCanvas'

const graph = { nodes: [], edges: [] } as unknown as BrainGraph

function setup(onSelect = vi.fn()) {
  render(<BrainGraphCanvas graph={graph} onSelect={onSelect} />)
  const wrap = document.querySelector<HTMLElement>('[data-brain-graph="full"]')!
  const cv = wrap.querySelector('canvas')!
  const wheel = () => {
    const e = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
    cv.dispatchEvent(e)
    return e.defaultPrevented
  }
  const click = () => {
    fireEvent.pointerDown(cv, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(cv, { pointerId: 1, clientX: 10, clientY: 10 })
  }
  return { wrap, cv, wheel, click }
}

afterEach(cleanup)

describe('the graph is taken in hand by a click (the wheel scrolls the page otherwise)', () => {
  it('leaves the wheel to the page until clicked, then zooms with it', () => {
    const { wrap, wheel, click } = setup()
    expect(wrap.dataset.brainActive).toBe('false')
    expect(wheel()).toBe(false)
    expect(document.querySelector('[data-brain-hint]')?.textContent).toBe('Click to zoom and move')
    click()
    expect(wrap.dataset.brainActive).toBe('true')
    expect(wheel()).toBe(true)
    expect(document.querySelector('[data-brain-hint]')).toBeNull()
  })

  it('a drag while out of hand does not take it in hand', () => {
    const { wrap, cv } = setup()
    fireEvent.pointerDown(cv, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(cv, { pointerId: 1, clientX: 60, clientY: 40 })
    fireEvent.pointerUp(cv, { pointerId: 1, clientX: 60, clientY: 40 })
    expect(wrap.dataset.brainActive).toBe('false')
  })

  it('lets go on Escape, without the Escape reaching the page', () => {
    const { wrap, wheel, click } = setup()
    const page = vi.fn()
    document.addEventListener('keydown', page)
    click()
    fireEvent.keyDown(wrap, { key: 'Escape' })
    document.removeEventListener('keydown', page)
    expect(wrap.dataset.brainActive).toBe('false')
    expect(page).not.toHaveBeenCalled()
    expect(wheel()).toBe(false)
  })

  it('lets go on a click outside or the mouse leaving', () => {
    const { wrap, click } = setup()
    click()
    fireEvent.pointerDown(document.body)
    expect(wrap.dataset.brainActive).toBe('false')
    click()
    fireEvent.pointerLeave(wrap, { pointerType: 'mouse' })
    expect(wrap.dataset.brainActive).toBe('false')
  })

  it('is taken in hand from the keyboard, and Fit works either way', () => {
    const { wrap } = setup()
    fireEvent.click(document.querySelector('[data-brain-fit]')!)
    expect(wrap.dataset.brainActive).toBe('false')
    expect(wrap.tabIndex).toBe(0)
    fireEvent.keyDown(wrap, { key: 'Enter' })
    expect(wrap.dataset.brainActive).toBe('true')
    fireEvent.click(document.querySelector('[data-brain-fit]')!)
    expect(wrap.dataset.brainActive).toBe('true')
  })

  it('the small one never takes the wheel', () => {
    render(<BrainGraphCanvas graph={graph} mini />)
    const cv = document.querySelector('[data-brain-graph="mini"] canvas')!
    const e = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
    cv.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(document.querySelector('[data-brain-graph="mini"]')?.getAttribute('tabindex')).toBeNull()
  })
})
