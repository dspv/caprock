import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArrivalQueue, arrivalSource, flightFrames, MAX_QUEUED } from './BrainArrivals'
import { brainArrivalsOn, brainArrivalsSetting, setBrainArrivals } from '@/lib/brain'

/** jsdom draws nothing: give an element a box. */
function boxed(html: string, rect = { left: 10, top: 20, width: 200, height: 30 }) {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  for (const el of host.querySelectorAll<HTMLElement>('[data-boxed]')) {
    el.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect
  }
  return host
}

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
})

describe('arrivalSource', () => {
  it('flies from the session’s sidebar row first, then its tab, then its project’s row', () => {
    boxed(`
      <div role="tab" data-session-id="s1" data-boxed id="tab"></div>
      <button data-tab-row="t1" data-session-id="s1" data-boxed id="row"></button>
      <button data-project-row="p" data-project-name="acme-api" data-boxed id="proj"></button>`)
    expect(arrivalSource({ session: 's1', project: 'acme-api' })?.id).toBe('row')
    expect(arrivalSource({ session: 'gone', project: 'acme-api' })?.id).toBe('proj')
    expect(arrivalSource({ project: 'other' })).toBeNull()
  })
  it('skips a place that is not drawn', () => {
    boxed('<button data-tab-row="t1" data-session-id="s1" data-boxed></button><div role="tab" data-session-id="s1" id="tab"></div>', { left: 0, top: 0, width: 0, height: 0 })
    expect(arrivalSource({ session: 's1' })).toBeNull()
  })
})

describe('flightFrames', () => {
  it('starts where it takes off, lands on the card, and fades in and out', () => {
    const f = flightFrames({ x: 10, y: 400 }, { x: 60, y: 900 })
    expect(f[0]!.transform).toContain('translate3d(10.0px, 400.0px, 0)')
    expect(f.at(-1)!.transform).toContain('translate3d(60.0px, 900.0px, 0)')
    expect(f[0]!.opacity).toBe(0)
    expect(Number(f.at(-1)!.opacity)).toBeCloseTo(0)
    expect(Math.max(...f.map((k) => Number(k.opacity)))).toBe(1)
  })
})

describe('ArrivalQueue', () => {
  it('holds a burst up to its cap, in order', () => {
    const q = new ArrivalQueue()
    for (let i = 1; i <= MAX_QUEUED + 3; i++) q.push({ id: i, op: 'added' })
    expect(q.size).toBe(MAX_QUEUED)
    expect(q.next()?.id).toBe(1)
  })
})

describe('Animate thoughts arriving', () => {
  it('is on until turned off, kept in this browser, and never under reduced motion', () => {
    expect(brainArrivalsSetting()).toBe(true)
    setBrainArrivals(false)
    expect(brainArrivalsSetting()).toBe(false)
    expect(brainArrivalsOn()).toBe(false)
    setBrainArrivals(true)
    expect(brainArrivalsOn()).toBe(true)
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    expect(brainArrivalsOn()).toBe(false)
    vi.unstubAllGlobals()
  })
})
