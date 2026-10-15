/**
 * A pretend layout for tests of code that measures (lib/keyChipFit): jsdom
 * lays nothing out, so every width is 0. `stubLayout` gives the elements
 * matching a selector the widths a browser would report, and
 * `captureResizeObservers` holds every ResizeObserver made so a test can say
 * "the sidebar resized" when it chooses. Tests only.
 */
import { vi } from 'vitest'

export interface Box { clientWidth?: number; scrollWidth?: number; width?: number }

/** Widths by selector; the first selector an element matches wins. Returns the undo. */
export function stubLayout(boxes: Record<string, Box>): () => void {
  const find = (el: Element): Box | undefined => {
    for (const [sel, box] of Object.entries(boxes)) if (el.matches(sel)) return box
    return undefined
  }
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return find(this)?.clientWidth ?? 0 }),
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) { const b = find(this); return b?.scrollWidth ?? b?.clientWidth ?? 0 }),
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const b = find(this)
      const w = b?.width ?? b?.clientWidth ?? 0
      return { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: w, width: w, height: 0, toJSON: () => ({}) } as DOMRect
    }),
  ]
  return () => { for (const s of spies) s.mockRestore() }
}

/** Every ResizeObserver made from now on; `fire()` calls them all. Returns the undo too. */
export function captureResizeObservers(): { fire: () => void; restore: () => void } {
  const before = globalThis.ResizeObserver
  const live = new Set<() => void>()
  class Captured implements ResizeObserver {
    private readonly run: () => void
    constructor(cb: ResizeObserverCallback) { this.run = () => cb([], this) }
    observe(): void { live.add(this.run) }
    unobserve(): void {}
    disconnect(): void { live.delete(this.run) }
  }
  globalThis.ResizeObserver = Captured
  return { fire: () => { for (const f of [...live]) f() }, restore: () => { globalThis.ResizeObserver = before } }
}
