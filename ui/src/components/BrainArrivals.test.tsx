import { afterEach, describe, expect, it, vi } from 'vitest'
import { arrivalSource, curve, handoffTarget, TYPING_QUIET_MS, WISP_GAP_MS, WispLane, wispsRunning, type LaneClock } from './BrainArrivals'
import { readFaces, faceWords } from './BrainAgents'
import { brainArrivalsOn, brainArrivalsSetting, setBrainArrivals } from '@/lib/brain'
import type { BrainAutoStatus } from '@/lib/api'

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
  it('starts from the session’s sidebar row first, then its tab, then its project’s row, then its agent’s face', () => {
    boxed(`
      <div role="tab" data-session-id="s1" data-boxed id="tab"></div>
      <button data-tab-row="t1" data-session-id="s1" data-boxed id="row"></button>
      <button data-project-row="p" data-project-name="acme-api" data-boxed id="proj"></button>
      <span data-brain-face="claude" data-boxed id="claude"></span>
      <span data-brain-face="codex" data-boxed id="codex"></span>`)
    expect(arrivalSource({ session: 's1', project: 'acme-api', agent: 'claude' })?.id).toBe('row')
    expect(arrivalSource({ session: 'gone', project: 'acme-api' })?.id).toBe('proj')
    expect(arrivalSource({ session: 'gone', project: 'other', agent: 'codex' })?.id).toBe('codex')
    // Never another agent's face: that would say something untrue.
    expect(arrivalSource({ project: 'other', agent: 'gemini' })).toBeNull()
    expect(arrivalSource({ project: 'other' })).toBeNull()
  })
  it('skips a place that is not drawn', () => {
    boxed('<button data-tab-row="t1" data-session-id="s1" data-boxed></button><div role="tab" data-session-id="s1" id="tab"></div>', { left: 0, top: 0, width: 0, height: 0 })
    expect(arrivalSource({ session: 's1' })).toBeNull()
  })
  it('hands memories out into the session’s tab only', () => {
    boxed('<button data-tab-row="t1" data-session-id="s1" data-boxed></button>')
    expect(handoffTarget('s1')).toBeNull()
    boxed('<div role="tab" data-session-id="s1" data-boxed id="tab"></div>')
    expect(handoffTarget('s1')?.id).toBe('tab')
  })
})

describe('curve', () => {
  it('starts where it takes off and ends where it lands, bowed off the straight line', () => {
    const c = curve({ x: 10, y: 400 }, { x: 60, y: 900 })
    expect(c.at(0)).toEqual({ x: 10, y: 400 })
    expect(c.at(1)).toEqual({ x: 60, y: 900 })
    const mid = c.at(0.5)
    expect(Math.abs(mid.x - 35) + Math.abs(mid.y - 650)).toBeGreaterThan(5)
  })
})

/** A clock a test moves by hand, with timers it fires itself. */
function fakeClock() {
  let t = 1_000_000
  let key = -Infinity
  let hidden = false
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: LaneClock = {
    now: () => t,
    lastKey: () => key,
    hidden: () => hidden,
    setTimer: (fn, ms) => { timers.set(++seq, { at: t + ms, fn }); return seq },
    clearTimer: (id) => { timers.delete(id) },
  }
  const advance = (ms: number) => {
    t += ms
    for (const [id, tm] of [...timers]) if (tm.at <= t) { timers.delete(id); tm.fn() }
  }
  return { clock, advance, type: () => { key = t }, hide: (v: boolean) => { hidden = v }, pending: () => timers.size }
}

describe('WispLane', () => {
  it('plays at once, then at most one a minute, merging what came in between', () => {
    const f = fakeClock()
    const played: [number, string][] = []
    const lane = new WispLane<string>((n, m) => played.push([n, m]), f.clock)
    lane.request(3, 'a')
    expect(played).toEqual([[3, 'a']])
    f.advance(5_000)
    lane.request(2, 'b')
    f.advance(5_000)
    lane.request(4, 'c')
    expect(played).toHaveLength(1)
    expect(lane.waiting).toBe(6)
    f.advance(WISP_GAP_MS)
    // One wisp for both, with the summed count, going where the newest goes.
    expect(played).toEqual([[3, 'a'], [6, 'c']])
    expect(lane.waiting).toBe(0)
  })
  it('waits until the viewer has stopped typing', () => {
    const f = fakeClock()
    const played: number[] = []
    const lane = new WispLane<null>((n) => played.push(n), f.clock)
    f.type()
    lane.request(1, null)
    expect(played).toEqual([])
    f.advance(1_000)
    f.type()
    f.advance(1_500)
    expect(played).toEqual([])
    f.advance(TYPING_QUIET_MS)
    expect(played).toEqual([1])
  })
  it('plays nothing in a hidden window, and replays nothing after', () => {
    const f = fakeClock()
    const played: number[] = []
    const lane = new WispLane<null>((n) => played.push(n), f.clock)
    f.hide(true)
    lane.request(2, null)
    f.hide(false)
    f.advance(WISP_GAP_MS * 2)
    expect(played).toEqual([])
    // Waiting when the window is hidden: dropped too.
    lane.request(1, null)
    lane.request(1, null)
    f.hide(true)
    f.advance(WISP_GAP_MS + 100)
    f.hide(false)
    f.advance(WISP_GAP_MS)
    expect(played).toEqual([1])
  })
  it('ignores a read that kept nothing', () => {
    const f = fakeClock()
    const played: number[] = []
    const lane = new WispLane<null>((n) => played.push(n), f.clock)
    lane.request(0, null)
    expect(played).toEqual([])
    expect(f.pending()).toBe(0)
  })
})

describe('the effects canvas', () => {
  it('is not there while nothing plays', () => {
    expect(wispsRunning()).toBe(false)
    expect(document.querySelector('[data-brain-wisps]')).toBeNull()
  })
})

describe('readFaces', () => {
  const auto = (over: Partial<BrainAutoStatus>) => ({ on: true, ...over }) as BrainAutoStatus
  it('shows only the agents read in the last 24 hours, the one read now lit', () => {
    expect(readFaces(auto({}))).toEqual([])
    const faces = readFaces(auto({
      agents_24h: [{ agent: 'claude', sessions: 6, last_at: 1 }, { agent: 'codex', sessions: 2, last_at: 1 }, { agent: 'mystery', sessions: 9, last_at: 1 }],
      reading: { session_id: 's', agent: 'codex', title: 'Fix login', started_at: 1, passages: 3 } as BrainAutoStatus['reading'],
    }))
    expect(faces.map((f) => [f.agent, f.now])).toEqual([['claude', false], ['codex', true]])
    expect(faceWords(faces[0]!)).toBe('Claude Code: 6 sessions read in the last 24 hours')
    expect(faceWords(faces[1]!)).toBe('Codex: 2 sessions read in the last 24 hours · reading “Fix login” now')
  })
  it('adds the agent being read when it was not read before today', () => {
    const faces = readFaces(auto({ agents_24h: [], reading: { session_id: 's', agent: 'gemini', started_at: 1, passages: 1 } as BrainAutoStatus['reading'] }))
    expect(faces.map((f) => f.agent)).toEqual(['gemini'])
    expect(faceWords(faces[0]!)).toBe('Gemini CLI: reading a session now')
  })
})

describe('Show memories moving', () => {
  it('is on until turned off, kept in this browser; the graph’s spark never moves under reduced motion', () => {
    expect(brainArrivalsSetting()).toBe(true)
    setBrainArrivals(false)
    expect(brainArrivalsSetting()).toBe(false)
    expect(brainArrivalsOn()).toBe(false)
    setBrainArrivals(true)
    expect(brainArrivalsOn()).toBe(true)
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    expect(brainArrivalsOn()).toBe(false)
    // The setting itself stays on: under reduced motion the count still shows.
    expect(brainArrivalsSetting()).toBe(true)
    vi.unstubAllGlobals()
  })
})
