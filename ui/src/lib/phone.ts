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
import { useEffect, useRef, useState } from 'react'

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

/** How far a finger must move the chat before the bar reacts, in px. */
export const HIDE_SLACK_PX = 6

/** A scroll within this long of a touch or a wheel is the reader's own. */
const INTENT_MS = 500

/**
 * Hide-on-scroll, as a phone's browser does with its address bar: scrolling
 * the chat down (reading on) hides the bar above it, scrolling up or reaching
 * the top brings it back. Only the reader's own scrolling counts — the chat
 * following a streaming answer to the bottom is not a reason to hide
 * anything. The bar is drawn over the chat, not above it, so hiding it moves
 * nothing in the conversation (components/PhoneSessionBar).
 */
export function useHideOnScroll(el: HTMLElement | null, on: boolean, top = 44): [hidden: boolean, show: () => void] {
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    if (!on || !el) {
      setHidden(false)
      return
    }
    let last = el.scrollTop
    let intentAt = 0
    const intent = () => { intentAt = Date.now() }
    const onScroll = () => {
      const st = el.scrollTop
      const dy = st - last
      if (Math.abs(dy) < HIDE_SLACK_PX) return
      last = st
      if (st <= top) return setHidden(false)
      if (Date.now() - intentAt > INTENT_MS) return
      setHidden(dy > 0)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('touchstart', intent, { passive: true })
    el.addEventListener('touchmove', intent, { passive: true })
    el.addEventListener('wheel', intent, { passive: true })
    el.addEventListener('keydown', intent)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('touchstart', intent)
      el.removeEventListener('touchmove', intent)
      el.removeEventListener('wheel', intent)
      el.removeEventListener('keydown', intent)
    }
  }, [el, on, top])
  return [hidden, () => setHidden(false)]
}

/** How far a pull at the top of the page must travel to ask again. */
export const PULL_PX = 64

/**
 * Pull to refresh, for the home-screen app only: a finger that starts at the
 * very top of the page and pulls down by PULL_PX calls `onPull` once on
 * release. The browser's own pull reloads the whole page, which reads
 * everything anyway, so this listens only where there is none — an installed
 * app (`standalone`) — and never twice. Passive listeners: the page scrolls
 * as it always did. Returns how far the finger has pulled, 0 at rest, for
 * the screen to draw its hint.
 */
export function usePullToRefresh(onPull: () => void, on: boolean): number {
  const [pulled, setPulled] = useState(0)
  const fn = useRef(onPull)
  fn.current = onPull
  useEffect(() => {
    if (!on) return
    let start = -1
    let dist = 0
    const top = () => (document.scrollingElement?.scrollTop ?? window.scrollY) <= 0
    const down = (e: TouchEvent) => {
      start = e.touches.length === 1 && top() ? e.touches[0]!.clientY : -1
      dist = 0
    }
    const move = (e: TouchEvent) => {
      if (start < 0) return
      // Resistance: the hint moves at half the finger's speed.
      dist = Math.max(0, (e.touches[0]!.clientY - start) / 2)
      if (!top()) { start = -1; dist = 0 }
      setPulled(dist)
    }
    const up = () => {
      if (start >= 0 && dist >= PULL_PX) fn.current()
      start = -1
      dist = 0
      setPulled(0)
    }
    window.addEventListener('touchstart', down, { passive: true })
    window.addEventListener('touchmove', move, { passive: true })
    window.addEventListener('touchend', up)
    window.addEventListener('touchcancel', up)
    return () => {
      window.removeEventListener('touchstart', down)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', up)
      window.removeEventListener('touchcancel', up)
    }
  }, [on])
  return pulled
}
