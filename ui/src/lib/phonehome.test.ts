import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import { CONTINUE_WINDOW_MS, continueList, installWay, messageWith, openFromHash, sharedFromSearch, waitingOnYou } from './phonehome'

const NOW = 1_800_000_000_000

function s(id: string, health: string, at: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: id, status: 'live', owned: true, last_event_at: at, worked_at: at,
    activity: { health, phrase: '', at: '' }, ...extra,
  } as unknown as SessionSummary
}

describe('continueList', () => {
  it('puts what waits on you first, then work in progress, then the rest, newest first', () => {
    const list = [
      s('idle-new', 'idle', NOW - 1000),
      s('working-old', 'working', NOW - 50_000),
      s('waiting', 'waiting-on-you', NOW - 90_000),
      s('working-new', 'working', NOW - 10_000),
      s('ended', 'ended', NOW - 5000, { status: 'ended' } as Partial<SessionSummary>),
    ]
    expect(continueList(list, NOW).map((x) => x.session_id)).toEqual(['waiting', 'working-new', 'working-old', 'idle-new', 'ended'])
  })

  it('drops what went quiet more than two days ago, unless it is working or waiting', () => {
    const old = NOW - CONTINUE_WINDOW_MS - 1
    const list = [s('stale', 'idle', old), s('stale-ended', 'ended', old, { status: 'ended' } as Partial<SessionSummary>), s('busy', 'working', old)]
    expect(continueList(list, NOW).map((x) => x.session_id)).toEqual(['busy'])
  })

  it('keeps at most five', () => {
    const list = Array.from({ length: 9 }, (_, i) => s(`x${i}`, 'idle', NOW - i))
    expect(continueList(list, NOW)).toHaveLength(5)
  })
})

describe('waitingOnYou', () => {
  it('answers only sessions Caprock started and that still run', () => {
    const list = [
      s('mine', 'waiting-on-you', NOW),
      s('theirs', 'waiting-on-you', NOW, { owned: false }),
      s('gone', 'waiting-on-you', NOW, { status: 'ended' } as Partial<SessionSummary>),
      s('busy', 'working', NOW),
    ]
    expect(waitingOnYou(list).map((x) => x.session_id)).toEqual(['mine'])
  })
})

describe('sharedFromSearch', () => {
  it('is null when nothing was shared', () => {
    expect(sharedFromSearch('')).toBeNull()
    expect(sharedFromSearch('?app=1')).toBeNull()
  })
  it('joins title, text and link, dropping a part another already holds', () => {
    expect(sharedFromSearch('?title=Issue+412&text=Look+at+this&url=https%3A%2F%2Fexample.com%2F412')?.text)
      .toBe('Issue 412\nLook at this\nhttps://example.com/412')
    expect(sharedFromSearch('?title=&text=https%3A%2F%2Fexample.com%2Fa&url=https%3A%2F%2Fexample.com%2Fa')?.text)
      .toBe('https://example.com/a')
  })
})

describe('openFromHash', () => {
  it('reads the home-screen shortcuts', () => {
    expect(openFromHash('#/?open=chat')).toBe('chat')
    expect(openFromHash('#/?open=save')).toBe('save')
    expect(openFromHash('#/?open=rm')).toBeNull()
    expect(openFromHash('#/')).toBeNull()
  })
})

describe('messageWith', () => {
  it('puts the words first and each path quoted after a blank line', () => {
    expect(messageWith(' fix it ', ['/d/paste/a b.png'])).toBe('fix it\n\n"/d/paste/a b.png"')
    expect(messageWith('', ['/a.png', '/b.png'])).toBe('"/a.png" "/b.png"')
    expect(messageWith('only words', [])).toBe('only words')
  })
})

describe('installWay', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
  const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36'
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'
  it('says how on each phone, and nothing once it is the home-screen app', () => {
    expect(installWay(iphone, false, 5)).toBe('ios')
    expect(installWay(android, false, 5)).toBe('android')
    expect(installWay(iphone, true, 5)).toBeNull()
  })
  it('takes an iPad that says Macintosh for iOS, and a desktop for nothing', () => {
    expect(installWay(mac, false, 5)).toBe('ios')
    expect(installWay(mac, false, 0)).toBeNull()
  })
})
