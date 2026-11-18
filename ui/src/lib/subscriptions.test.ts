import { describe, expect, it, beforeEach } from 'vitest'
import type { Subscription } from './api'
import { chosenId, forgetAgentPicks, forgetSubscription, preferredId, fullest, isNear, leftText, rememberedSubscription, rememberSubscription, withRoom } from './subscriptions'

const NOW = 1_800_000_000

function sub(id: string, windows: [Subscription['windows'][number]['window'], number, number?][], signedIn = true): Subscription {
  return {
    id, agent: 'claude', label: id, default: id === 'default', dir: `/d/${id}`, signed_in: signedIn, login_command: 'claude auth login',
    windows: windows.map(([window, used, resets = NOW + 3600]) => ({ window, used_percentage: used, resets_at: resets, observed_at: 0 })),
    sessions_7d: 0, cost_7d_usd: 0, running: 0,
  }
}

describe('subscriptions', () => {
  beforeEach(() => localStorage.clear())

  it('reads the fullest current window and ignores one that has reset', () => {
    const s = sub('a', [['five_hour', 95, NOW - 10], ['seven_day', 40]])
    expect(fullest(s, NOW)?.window).toBe('seven_day')
    expect(isNear(s, NOW)).toBe(false)
    expect(isNear(sub('b', [['five_hour', 90]]), NOW)).toBe(true)
    expect(isNear(sub('c', []), NOW)).toBe(false)
  })

  it('says what is LEFT of the tightest current window, or why there is no figure', () => {
    expect(leftText(sub('a', [['five_hour', 38], ['seven_day', 70]]), NOW)).toBe('30% of weekly left')
    expect(leftText(sub('b', [['five_hour', 37.6]]), NOW)).toBe('62% of 5-hour left')
    expect(leftText(sub('c', [['five_hour', 104]]), NOW)).toBe('0% of 5-hour left')
    // A reset that has passed is not 100% left: it reopened, and that is all that is known.
    expect(leftText(sub('d', [['five_hour', 71, NOW - 60], ['seven_day', 20]]), NOW)).toBe('80% of weekly left')
    expect(leftText(sub('e', [['five_hour', 71, NOW - 60]]), NOW)).toMatch(/^5-hour reopened \S/)
    expect(leftText(sub('f', []), NOW)).toBe('no figures yet')
    expect(leftText(sub('g', [['five_hour', 10]], false), NOW)).toBe('not signed in')
  })

  it('offers the ones with room, known figures first, never the chosen or a signed-out one', () => {
    const list = [sub('default', [['five_hour', 93]]), sub('work', [['five_hour', 60]]), sub('home', []), sub('team', [['five_hour', 20]]), sub('new', [], false), sub('full', [['seven_day', 99]])]
    expect(withRoom(list, 'default', NOW).map((s) => s.id)).toEqual(['team', 'work', 'home'])
  })

  it('remembers a pick per agent and project, and forgets a removed one', () => {
    expect(rememberedSubscription('claude', 'p1')).toBe('')
    rememberSubscription('claude', 'p1', 'ab12')
    rememberSubscription('codex', 'p1', 'cd34')
    expect(rememberedSubscription('claude', 'p1')).toBe('ab12')
    expect(rememberedSubscription('claude', 'p2')).toBe('')
    forgetSubscription('ab12')
    expect(rememberedSubscription('claude', 'p1')).toBe('')
    expect(rememberedSubscription('codex', 'p1')).toBe('cd34')
  })

  it('falls back to the one made the default, and Make default forgets the picks', () => {
    const list = [sub('default', []), { ...sub('work', []), preferred: true }, sub('home', [])]
    expect(preferredId(list)).toBe('work')
    expect(chosenId(list, '')).toBe('work')
    expect(chosenId(list, 'default')).toBe('default')
    expect(chosenId(list, 'gone')).toBe('work')
    expect(preferredId([sub('default', [])])).toBe('default')
    rememberSubscription('claude', 'p1', 'home')
    rememberSubscription('claude', 'p2', 'default')
    rememberSubscription('codex', 'p1', 'cd34')
    forgetAgentPicks('claude')
    expect(rememberedSubscription('claude', 'p1')).toBe('')
    expect(rememberedSubscription('claude', 'p2')).toBe('')
    expect(rememberedSubscription('codex', 'p1')).toBe('cd34')
  })
})
