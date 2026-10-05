/**
 * The scrolling rule (.ai/21-app.md § The scrolling rule, WP-11): the content
 * never moves under someone reading it.
 *
 * - **Follow only at the edge.** Within 4 px of the live edge (the bottom of a
 *   list that grows downwards, the top of a newest-first feed) the view
 *   follows new content. Anywhere else it stays exactly where it is.
 * - **Anchor preserved.** Before any change the first visible row and its
 *   offset are known; after it, the offset is restored. Rows inserted above,
 *   rows trimmed off the start, a row growing as it streams — none of them
 *   move what is on screen. The browser's own `overflow-anchor` is switched
 *   off for the container so the two never correct the same shift twice, and
 *   Safari, which has none, behaves the same.
 * - **A pill, not a jump.** Away from the edge, `newCount` says how many rows
 *   arrived; `jump()` goes to the edge and resumes following.
 *
 * The correction runs from a MutationObserver, which fires after the DOM
 * changes and before the frame is painted, so a shift is never drawn.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** How close to the edge still counts as at it. */
export const FOLLOW_SLACK_PX = 4

export type LiveEdge = 'bottom' | 'top'

export interface StickOptions {
  /** Where new rows arrive. */
  edge?: LiveEdge
  /**
   * A count that grows by one per row received — not the rows held, which a
   * capped list keeps level — so `newCount` keeps counting after a trim.
   */
  total: number
}

export interface Stick {
  /** Attach to the scrolling element. */
  ref: (el: HTMLElement | null) => void
  atEdge: boolean
  /** Rows received since the reader left the edge. */
  newCount: number
  /** Go to the edge and follow again. */
  jump: () => void
}

interface Anchor {
  el: Element
  offset: number
}

/** Distance from the live edge, in px. */
export function edgeDistance(el: HTMLElement, edge: LiveEdge): number {
  return edge === 'bottom' ? el.scrollHeight - el.scrollTop - el.clientHeight : el.scrollTop
}

/** The first row whose bottom is below the container's top: what the reader's eye is on. */
export function findAnchor(el: HTMLElement): Anchor | undefined {
  const top = el.getBoundingClientRect().top
  for (const child of Array.from(el.children)) {
    const r = child.getBoundingClientRect()
    if (r.bottom > top + 0.5 && r.height > 0) return { el: child, offset: r.top - top }
  }
  return undefined
}

/** Scroll so the edge is in view. */
export function scrollToEdge(el: HTMLElement, edge: LiveEdge): void {
  el.scrollTop = edge === 'bottom' ? el.scrollHeight : 0
}

export function useStickToBottom({ edge = 'bottom', total }: StickOptions): Stick {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [atEdge, setAtEdge] = useState(true)
  const [leftAt, setLeftAt] = useState(total)
  const following = useRef(true)
  const anchor = useRef<Anchor | undefined>(undefined)
  const totalRef = useRef(total)
  totalRef.current = total

  const ref = useCallback((el: HTMLElement | null) => setNode(el), [])

  const remember = useCallback((el: HTMLElement) => {
    anchor.current = findAnchor(el)
  }, [])

  useEffect(() => {
    if (!node) return
    node.style.overflowAnchor = 'none'
    // A list that grows downwards opens at its bottom, following. A
    // newest-first one opens where it is: at its top, unless something already
    // scrolled it to a row the reader asked for (a minute picked on the pulse).
    if (edge === 'bottom') scrollToEdge(node, edge)
    following.current = edgeDistance(node, edge) <= FOLLOW_SLACK_PX
    setAtEdge(following.current)
    remember(node)

    const onScroll = () => {
      const at = edgeDistance(node, edge) <= FOLLOW_SLACK_PX
      if (at !== following.current) {
        following.current = at
        setAtEdge(at)
        if (!at) setLeftAt(totalRef.current)
      }
      remember(node)
    }

    const restore = () => {
      if (following.current) {
        scrollToEdge(node, edge)
      } else {
        const a = anchor.current
        if (a && a.el.isConnected) {
          const now = a.el.getBoundingClientRect().top - node.getBoundingClientRect().top
          const delta = now - a.offset
          if (Math.abs(delta) >= 0.5) node.scrollTop += delta
        }
      }
      remember(node)
    }

    node.addEventListener('scroll', onScroll, { passive: true })
    const mo = new MutationObserver(restore)
    mo.observe(node, { childList: true, subtree: true, characterData: true })
    // The container itself resizing (a window resize, a panel opening) is a
    // change too: following stays at the edge, reading keeps its row.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(restore) : undefined
    ro?.observe(node)
    return () => {
      node.removeEventListener('scroll', onScroll)
      mo.disconnect()
      ro?.disconnect()
    }
  }, [node, edge, remember])

  const jump = useCallback(() => {
    if (!node) return
    following.current = true
    setAtEdge(true)
    scrollToEdge(node, edge)
    remember(node)
  }, [node, edge, remember])

  return { ref, atEdge, newCount: atEdge ? 0 : Math.max(0, total - leftAt), jump }
}
