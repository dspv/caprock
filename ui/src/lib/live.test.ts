import { describe, expect, it } from 'vitest'
import { live } from './live'

describe('live store', () => {
  it('collects alerts and bumps tick on session/event frames', () => {
    const t0 = live.getState().tick
    live.handle({ type: 'event', data: { id: 1, ts: '', session_id: 's', source: 'hook', kind: 'tool.pre', payload: {} } })
    live.handle({ type: 'alert', data: { kind: 'loop', session_id: 's', tool: 'Bash', count: 5, window_min: 3, sample: 'Bash: x', first_ts: '', last_ts: '', ts: '' } })
    const st = live.getState()
    expect(st.tick).toBe(t0 + 2)
    expect(st.alerts).toHaveLength(1)
    expect(st.lastEvent?.kind).toBe('tool.pre')
    live.dismissAlert('s')
    expect(live.getState().alerts).toHaveLength(0)
  })
})
