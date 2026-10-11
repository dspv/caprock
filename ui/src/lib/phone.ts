/**
 * What a phone is, for the screens that change on one.
 *
 * Two questions, kept apart. *Narrow* is the layout: a window under the `sm`
 * breakpoint, where a session opens on its chat and the chat fills the
 * screen. *Touch* is the device: a primary pointer that is a finger, which is
 * what decides how heavy the terminal may be (lib/termwrite, Terminal.tsx) —
 * a narrow desktop window keeps the desktop's terminal, and a tablet held
 * wide still gets the light one.
 */
import { useEffect, useState } from 'react'

const NARROW = '(max-width: 639px)'
const TOUCH = '(pointer: coarse)'

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches
}

/** A phone-width window: under Tailwind's `sm`. */
export function narrowScreen(): boolean {
  return matches(NARROW)
}

/** A touch-first device (phone, tablet), never a desktop with a mouse. */
export function touchScreen(): boolean {
  return matches(TOUCH)
}

/** narrowScreen(), kept current as the window turns or is resized. */
export function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(narrowScreen)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(NARROW)
    const on = () => setNarrow(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return narrow
}

/**
 * Sizes an element to reach the bottom of what is visible, so a chat's field
 * sits at the bottom of the screen as in a messenger.
 *
 * The visual viewport, not `100dvh`: when the on-screen keyboard rises, iOS
 * shrinks the visual viewport and leaves the layout one alone, so a `dvh`
 * box keeps its field under the keyboard. Measured from the element's top in
 * the document, so scrolling does not feed back into the height; re-measured
 * when the viewport changes and when anything above it changes size (a
 * permission card arriving). Off (no height set) when `on` is false.
 */
export function useFillViewport<T extends HTMLElement>(on: boolean, gap = 8): (el: T | null) => void {
  const [el, setEl] = useState<T | null>(null)
  useEffect(() => {
    if (!on || !el) return
    const vv = window.visualViewport
    let raf = 0
    const fit = () => {
      raf = 0
      const top = el.getBoundingClientRect().top + window.scrollY
      const visible = vv ? vv.height : window.innerHeight
      // Never smaller than a usable conversation; the page scrolls instead.
      el.style.height = `${Math.max(280, Math.round(visible - top - gap))}px`
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(fit) }
    fit()
    vv?.addEventListener('resize', schedule)
    window.addEventListener('resize', schedule)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    if (el.parentElement) ro?.observe(el.parentElement)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      vv?.removeEventListener('resize', schedule)
      window.removeEventListener('resize', schedule)
      ro?.disconnect()
      el.style.height = ''
    }
  }, [on, el, gap])
  return setEl
}
