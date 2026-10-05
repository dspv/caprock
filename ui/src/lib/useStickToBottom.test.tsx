/**
 * The scrolling rule's acceptance (WP-11): 200 messages streamed while the
 * reader is scrolled up leave the first visible row within ±1 px; at the edge
 * the list follows. jsdom does no layout, so each row is given a fixed height
 * and the container a real scrollTop; the hook only ever reads geometry, so
 * this exercises the same arithmetic a browser would hand it.
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useStickToBottom, type LiveEdge } from './useStickToBottom'

const ROW = 20
const VIEW = 100

function List({ ids, total, edge, onStick }: { ids: number[]; total: number; edge: LiveEdge; onStick: (s: ReturnType<typeof useStickToBottom>) => void }) {
  const stick = useStickToBottom({ edge, total })
  onStick(stick)
  return (
    <div data-testid="box" ref={(el) => { if (el) geometry(el); stick.ref(el) }}>
      {ids.map((id) => <div key={id} data-row={id}>row {id}</div>)}
    </div>
  )
}

const tops = new WeakMap<HTMLElement, { v: number }>()
function geometry(el: HTMLElement) {
  if (tops.has(el)) return
  const st = { v: 0 }
  tops.set(el, st)
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => VIEW })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => el.children.length * ROW })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => st.v,
    set: (v: number) => { st.v = Math.max(0, Math.min(v, el.children.length * ROW - VIEW)) },
  })
}

const realRect = Element.prototype.getBoundingClientRect
beforeEach(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const parent = this.parentElement as HTMLElement | null
    if (this instanceof HTMLElement && this.dataset.row !== undefined && parent) {
      const i = Array.from(parent.children).indexOf(this)
      const top = i * ROW - parent.scrollTop
      return { top, bottom: top + ROW, height: ROW, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    }
    return { top: 0, bottom: VIEW, height: VIEW, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
})
afterEach(() => { Element.prototype.getBoundingClientRect = realRect })

function firstVisible(box: HTMLElement): { id: string; top: number } {
  for (const c of Array.from(box.children) as HTMLElement[]) {
    const r = c.getBoundingClientRect()
    if (r.bottom > 0) return { id: c.dataset.row!, top: r.top }
  }
  throw new Error('nothing visible')
}

function scrollBy(box: HTMLElement, to: number) {
  box.scrollTop = to
  box.dispatchEvent(new Event('scroll'))
}

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i)

describe('useStickToBottom — a list that grows downwards', () => {
  it('leaves the reader where they are while 200 messages stream in, and counts them', async () => {
    let stick!: ReturnType<typeof useStickToBottom>
    let ids = range(0, 50)
    const view = render(<List ids={ids} total={ids.length} edge="bottom" onStick={(s) => { stick = s }} />)
    const box = view.getByTestId('box')
    expect(box.scrollTop).toBe(50 * ROW - VIEW) // opened at the bottom
    await act(async () => scrollBy(box, 300))
    const before = firstVisible(box)
    for (let i = 0; i < 200; i++) {
      ids = [...ids, 50 + i]
      view.rerender(<List ids={ids} total={ids.length} edge="bottom" onStick={(s) => { stick = s }} />)
      await act(async () => {})
    }
    const after = firstVisible(box)
    expect(after.id).toBe(before.id)
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1)
    expect(Math.abs(box.scrollTop - 300)).toBeLessThanOrEqual(1)
    expect(stick.atEdge).toBe(false)
    expect(stick.newCount).toBe(200)
  }, 30_000)

  it('keeps the first visible row when the start of a capped list is trimmed', async () => {
    let ids = range(0, 60)
    const view = render(<List ids={ids} total={60} edge="bottom" onStick={() => {}} />)
    const box = view.getByTestId('box')
    await act(async () => scrollBy(box, 600))
    const before = firstVisible(box)
    // Ten rows arrive and the cap drops ten off the top.
    ids = [...ids.slice(10), ...range(60, 10)]
    view.rerender(<List ids={ids} total={70} edge="bottom" onStick={() => {}} />)
    await act(async () => {})
    const after = firstVisible(box)
    expect(after.id).toBe(before.id)
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1)
  })

  it('follows at the bottom, and the pill jumps back to following', async () => {
    let stick!: ReturnType<typeof useStickToBottom>
    let ids = range(0, 20)
    const view = render(<List ids={ids} total={ids.length} edge="bottom" onStick={(s) => { stick = s }} />)
    const box = view.getByTestId('box')
    ids = [...ids, 20, 21, 22]
    view.rerender(<List ids={ids} total={ids.length} edge="bottom" onStick={(s) => { stick = s }} />)
    await act(async () => {})
    expect(box.scrollTop).toBe(ids.length * ROW - VIEW)
    // 4 px short of the bottom still counts as the bottom.
    await act(async () => scrollBy(box, ids.length * ROW - VIEW - 4))
    ids = [...ids, 23]
    view.rerender(<List ids={ids} total={ids.length} edge="bottom" onStick={(s) => { stick = s }} />)
    await act(async () => {})
    expect(box.scrollTop).toBe(ids.length * ROW - VIEW)
    // Scrolled up, then the pill.
    await act(async () => scrollBy(box, 40))
    ids = [...ids, 24, 25]
    view.rerender(<List ids={ids} total={ids.length} edge="bottom" onStick={(s) => { stick = s }} />)
    await act(async () => {})
    expect(stick.newCount).toBe(2)
    await act(async () => stick.jump())
    expect(box.scrollTop).toBe(ids.length * ROW - VIEW)
    expect(stick.newCount).toBe(0)
  })
})

describe('useStickToBottom — a newest-first feed', () => {
  it('keeps the reader’s row when 200 rows arrive above it', async () => {
    let stick!: ReturnType<typeof useStickToBottom>
    let ids = range(1000, 50).reverse()
    let total = 0
    const view = render(<List ids={ids} total={total} edge="top" onStick={(s) => { stick = s }} />)
    const box = view.getByTestId('box')
    expect(box.scrollTop).toBe(0)
    await act(async () => scrollBy(box, 300))
    const before = firstVisible(box)
    for (let i = 0; i < 200; i++) {
      ids = [2000 + i, ...ids]
      total += 1
      view.rerender(<List ids={ids} total={total} edge="top" onStick={(s) => { stick = s }} />)
      await act(async () => {})
    }
    const after = firstVisible(box)
    expect(after.id).toBe(before.id)
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1)
    expect(stick.newCount).toBe(200)
  }, 30_000)

  it('at the top, shows the newest row as it arrives', async () => {
    let ids = range(0, 30)
    const view = render(<List ids={ids} total={0} edge="top" onStick={() => {}} />)
    const box = view.getByTestId('box')
    ids = [99, ...ids]
    view.rerender(<List ids={ids} total={1} edge="top" onStick={() => {}} />)
    await act(async () => {})
    expect(box.scrollTop).toBe(0)
    expect(firstVisible(box).id).toBe('99')
  })
})
