import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { BACK_PX, EDGE_PX, edgeSwipeBack } from './edgeSwipe'
import { pinchFont, readTermFont, TERM_FONT_MAX } from '@/components/Terminal'
import { useComposerFocus } from '@/lib/phone'

/** A touch event with its finger positions, as every engine reads them. */
function fire(target: EventTarget, type: string, pts: { x: number; y: number }[]) {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'touches', { value: pts.map((p) => ({ clientX: p.x, clientY: p.y })) })
  target.dispatchEvent(ev)
  return ev
}

describe('edgeSwipeBack', () => {
  let stop = () => {}
  afterEach(() => { stop(); document.body.innerHTML = '' })

  const swipe = (el: Element, x0: number, dx: number, dy = 0) => {
    fire(el, 'touchstart', [{ x: x0, y: 300 }])
    fire(el, 'touchmove', [{ x: x0 + dx / 2, y: 300 + dy / 2 }])
    fire(el, 'touchmove', [{ x: x0 + dx, y: 300 + dy }])
    fire(el, 'touchend', [])
  }

  it('from the left edge, far enough to the right: back one step, with a mark that follows', () => {
    history.pushState(null, '', '#/chats')
    const back = vi.fn()
    stop = edgeSwipeBack(window, back)
    const el = document.body.appendChild(document.createElement('div'))
    fire(el, 'touchstart', [{ x: EDGE_PX - 5, y: 300 }])
    fire(el, 'touchmove', [{ x: EDGE_PX + 40, y: 305 }])
    expect(document.querySelector('[data-edge-back]')).not.toBeNull()
    fire(el, 'touchend', [])
    expect(back).not.toHaveBeenCalled()
    expect(document.querySelector('[data-edge-back]')).toBeNull()
    swipe(el, 4, BACK_PX + 10)
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('not from the middle, not a scroll down the edge, not out of a code block or with a sheet open', () => {
    history.pushState(null, '', '#/chats/x')
    const back = vi.fn()
    stop = edgeSwipeBack(window, back)
    const el = document.body.appendChild(document.createElement('div'))
    swipe(el, 120, BACK_PX + 40)
    swipe(el, 4, 30, 200)
    const pre = document.body.appendChild(document.createElement('pre'))
    swipe(pre, 4, BACK_PX + 40)
    const sheet = document.body.appendChild(document.createElement('div'))
    sheet.setAttribute('role', 'dialog')
    swipe(el, 4, BACK_PX + 40)
    expect(back).not.toHaveBeenCalled()
  })
})

describe('the terminal\'s text size on a touch screen', () => {
  afterEach(() => localStorage.clear())

  it('a pinch scales it, in whole pixels, within the range', () => {
    const el = document.createElement('div')
    let size = 12
    const stop = pinchFont(el, () => size, (n) => { size = n })
    fire(el, 'touchstart', [{ x: 100, y: 100 }, { x: 200, y: 100 }])
    const ev = fire(el, 'touchmove', [{ x: 75, y: 100 }, { x: 225, y: 100 }])
    expect(size).toBe(18)
    expect(ev.defaultPrevented).toBe(true)
    fire(el, 'touchmove', [{ x: 0, y: 100 }, { x: 600, y: 100 }])
    expect(size).toBe(TERM_FONT_MAX)
    fire(el, 'touchend', [])
    // One finger scrolls: nothing changes.
    size = 12
    fire(el, 'touchstart', [{ x: 100, y: 100 }])
    fire(el, 'touchmove', [{ x: 100, y: 300 }])
    expect(size).toBe(12)
    stop()
  })

  it('kept per device; nonsense in storage is the default', () => {
    expect(readTermFont()).toBe(12)
    localStorage.setItem('caprock.phone.termFont', '15')
    expect(readTermFont()).toBe(15)
    localStorage.setItem('caprock.phone.termFont', '400')
    expect(readTermFont()).toBe(12)
  })
})

function Typing({ on }: { on: boolean }) {
  return <><textarea className="input composer-field" aria-label="f" /><button>b</button><span data-typing={String(useComposerFocus(on))} /></>
}

describe('useComposerFocus', () => {
  afterEach(cleanup)

  it('is true while a chat field has the focus', () => {
    const { container } = render(<Typing on />)
    const state = () => container.querySelector('[data-typing]')!.getAttribute('data-typing')
    expect(state()).toBe('false')
    act(() => (container.querySelector('textarea') as HTMLElement).focus())
    expect(state()).toBe('true')
    act(() => (container.querySelector('button') as HTMLElement).focus())
    expect(state()).toBe('false')
  })
})
