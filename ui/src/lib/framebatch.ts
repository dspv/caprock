/**
 * Live frames applied in batches: a screen that follows the live socket takes
 * what arrived in the last FRAME_BATCH_MS in one state update — one render —
 * instead of one render per frame. Agents at work send several frames a
 * second, and each used to redraw the screen that showed them. While the page
 * is hidden nothing is applied; it all lands at once when the page is shown
 * (lib/visible.ts coalesce).
 */
import { useEffect, useMemo, useRef } from 'react'
import { coalesce } from './visible'

/** At most one render per this many ms for a screen following the live feed: under the eye's notice. */
export const FRAME_BATCH_MS = 250

export interface FrameBatch<T> {
  /** Queue one item for the next batch. */
  push: (item: T) => void
  /** Drop what is queued (the screen moved to another subject). */
  cancel: () => void
}

/** A batcher outside React: `apply` gets everything pushed since the last call, in order. */
export function frameBatch<T>(apply: (items: T[]) => void, ms = FRAME_BATCH_MS): FrameBatch<T> {
  let queue: T[] = []
  const c = coalesce(() => {
    const out = queue
    queue = []
    if (out.length) apply(out)
  }, ms)
  return {
    push: (item) => { queue.push(item); c.ask() },
    cancel: () => { queue = []; c.cancel() },
  }
}

/** frameBatch for a component: `apply` may change between renders; what is queued is dropped on unmount. */
export function useFrameBatch<T>(apply: (items: T[]) => void, ms = FRAME_BATCH_MS): FrameBatch<T> {
  const ref = useRef(apply)
  ref.current = apply
  const batch = useMemo(() => frameBatch<T>((items) => ref.current(items), ms), [ms])
  useEffect(() => () => batch.cancel(), [batch])
  return batch
}
