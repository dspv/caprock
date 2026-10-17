import { describe, expect, it } from 'vitest'
import { PTT_IDLE, pttStep, slidOff, TAP_MS, type PttInput, type PttState } from './holdToTalk'

function run(inputs: PttInput[], from: PttState = PTT_IDLE) {
  let s = from
  const actions: string[] = []
  for (const i of inputs) {
    const r = pttStep(s, i)
    s = r.state
    if (r.action) actions.push(r.action)
  }
  return { state: s.phase, actions }
}

describe('hold-to-talk', () => {
  it('records while held and sends on release', () => {
    expect(run([{ type: 'down', at: 0 }, { type: 'up', at: 1200 }])).toEqual({ state: 'idle', actions: ['start', 'send'] })
  })

  it('latches on a short tap, and the next tap sends', () => {
    const tap = run([{ type: 'down', at: 0 }, { type: 'up', at: TAP_MS - 1 }])
    expect(tap).toEqual({ state: 'latched', actions: ['start'] })
    expect(run([
      { type: 'down', at: 0 }, { type: 'up', at: 100 },
      { type: 'down', at: 4000 }, { type: 'up', at: 4100 },
    ])).toEqual({ state: 'idle', actions: ['start', 'send'] })
  })

  it('cancels when the finger slides off while holding, and ignores it once latched', () => {
    expect(run([{ type: 'down', at: 0 }, { type: 'leave' }, { type: 'up', at: 900 }])).toEqual({ state: 'idle', actions: ['start', 'cancel'] })
    expect(run([{ type: 'down', at: 0 }, { type: 'up', at: 50 }, { type: 'leave' }])).toEqual({ state: 'latched', actions: ['start'] })
  })

  it('drops the recording on a pointer cancel, and does nothing when idle', () => {
    expect(run([{ type: 'down', at: 0 }, { type: 'cancel' }])).toEqual({ state: 'idle', actions: ['start', 'cancel'] })
    expect(run([{ type: 'cancel' }, { type: 'up', at: 5 }, { type: 'leave' }])).toEqual({ state: 'idle', actions: [] })
  })

  it('starts latched from the keyboard and sends on the next key', () => {
    expect(run([{ type: 'key' }])).toEqual({ state: 'latched', actions: ['start'] })
    expect(run([{ type: 'key' }, { type: 'key' }])).toEqual({ state: 'idle', actions: ['start', 'send'] })
  })

  it('counts a point as slid off only past the slop', () => {
    const r = { left: 100, right: 148, top: 500, bottom: 548 }
    expect(slidOff(r, 120, 520)).toBe(false)
    expect(slidOff(r, 160, 520)).toBe(false)
    expect(slidOff(r, 120, 400)).toBe(true)
    expect(slidOff(r, 60, 520)).toBe(true)
  })
})
