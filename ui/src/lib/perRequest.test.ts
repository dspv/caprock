import { describe, expect, it } from 'vitest'
import { volumeCount, volumeLine, volumeRate } from './perRequest'

describe('a model’s volume in the unit its cost was counted in', () => {
  // Cursor's opus-thinking on the owner's machine: 7 usage records, $623 and
  // 2,153 requests, which read "$89 per turn".
  const opus = { cost_usd: 623.08, turns: 0, requests: 2153, requests_cost_usd: 623.08 }

  it('reads Cursor’s cost per request', () => {
    expect(volumeLine(opus)).toBe('2,153 requests · $0.29/request')
    expect(volumeCount(opus)).toBe('2,153 requests')
  })

  it('divides only the requests’ own cost when another agent ran the same model', () => {
    expect(volumeRate({ cost_usd: 100, turns: 40, requests: 10, requests_cost_usd: 5 })).toBe('$0.50/request')
  })

  it('stays per turn for an agent that counts no requests', () => {
    expect(volumeLine({ cost_usd: 12, turns: 10 })).toBe('10 turns · $1.20/turn')
    expect(volumeLine({ cost_usd: 0, turns: 0 })).toBe('0 turns')
    expect(volumeCount({ cost_usd: 1, turns: 1 })).toBe('1 turn')
  })
})
