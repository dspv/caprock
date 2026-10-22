import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxItem, SessionSummary } from './api'
import {
  CONTINUE_LIVE_MAX, continueCounts, continueRows, DEFAULT_FOLDS, FOLDS_KEY, installWay, keepFolds, limitsGlance, messageWith,
  openFromHash, readFolds, rowMeta, savedSummary, sharedFromSearch, shortIn, waitingOnYou,
} from './phonehome'

const NOW = 1_800_000_000_000

function s(id: string, health: string, at: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: id, status: 'live', owned: true, last_event_at: at, worked_at: at,
    activity: { health, phrase: '', at: '' }, ...extra,
  } as unknown as SessionSummary
}

// Owner, 2026-10-22 (translated): a session is known by its place in the
// list; a row that moves because of what it is doing drives him mad.
describe('continueRows', () => {
  const ids = (r: { rows: SessionSummary[] }) => r.rows.map((x) => x.session_id)
  const tabs = (items: SessionSummary[], sessions = items.map((x) => x.session_id)) => ({ known: true, at: NOW, sessions, items })

  it("follows the computer's tab order, whatever each row is doing", () => {
    const a = s('a', 'idle', NOW - 90_000)
    const b = s('b', 'working', NOW - 1000)
    const c = s('c', 'waiting-on-you', NOW - 50_000)
    const first = continueRows(tabs([a, b, c]), false, [])
    expect(first.source).toBe('tabs')
    expect(ids(first)).toEqual(['a', 'b', 'c'])
    // a starts working, b finishes, c is answered: nobody moves.
    const next = continueRows(tabs([s('a', 'working', NOW), s('b', 'done', NOW - 1000), s('c', 'idle', NOW - 500)]), false, [])
    expect(ids(next)).toEqual(['a', 'b', 'c'])
    // A drag on the computer is the one thing that reorders.
    expect(ids(continueRows(tabs([c, a, b]), false, []))).toEqual(['c', 'a', 'b'])
  })

  it('lists only the tabs: no cap, a background session left out, an ended tab kept, shells never', () => {
    const many = Array.from({ length: 12 }, (_, i) => s(`t${i}`, 'idle', NOW - i))
    const ended = s('gone', 'idle', NOW - 9, { status: 'ended' } as Partial<SessionSummary>)
    const shell = s('sh', 'idle', NOW, { kind: 'shell' } as Partial<SessionSummary>)
    const background = s('bg', 'working', NOW)
    const r = continueRows(tabs([...many, ended, shell, many[0]!]), false, [background, ...many])
    expect(ids(r)).toEqual([...many.map((x) => x.session_id), 'gone'])
  })

  it('a known empty list is empty, not the live sessions', () => {
    const r = continueRows({ known: true, at: NOW, sessions: [], items: [] }, false, [s('x', 'working', NOW)])
    expect(r).toEqual({ rows: [], source: 'tabs' })
  })

  it('draws nothing while the tabs are first read, so the rows never jump from one order to another', () => {
    expect(continueRows(undefined, false, [s('x', 'working', NOW)])).toEqual({ rows: [], source: 'reading' })
  })

  it('without tabs: the live sessions, oldest started first, a change of state moving nobody', () => {
    const list = (h: [string, string, string]) => [
      s('new', h[0], NOW - 1000, { started_at: 300 } as Partial<SessionSummary>),
      s('old', h[1], NOW - 90_000, { started_at: 100 } as Partial<SessionSummary>),
      s('mid', h[2], NOW - 50_000, { started_at: 200 } as Partial<SessionSummary>),
      s('ended', 'idle', NOW - 5, { status: 'ended', started_at: 50 } as Partial<SessionSummary>),
      s('sh', 'idle', NOW, { kind: 'shell', started_at: 1 } as Partial<SessionSummary>),
    ]
    const unknown = { known: false, at: 0, sessions: [], items: [] }
    const first = continueRows(unknown, false, list(['working', 'idle', 'waiting-on-you']))
    expect(first.source).toBe('live')
    expect(ids(first)).toEqual(['old', 'mid', 'new'])
    expect(ids(continueRows(unknown, false, list(['done', 'working', 'idle'])))).toEqual(['old', 'mid', 'new'])
    // An older daemon has no GET /v1/tabs: the same fallback.
    expect(ids(continueRows(undefined, true, list(['idle', 'idle', 'working'])))).toEqual(['old', 'mid', 'new'])
  })

  it('without tabs keeps the most recently started few, still oldest first', () => {
    const list = Array.from({ length: CONTINUE_LIVE_MAX + 3 }, (_, i) => s(`x${i}`, 'idle', NOW - i, { started_at: i + 1 } as Partial<SessionSummary>))
    const r = continueRows(undefined, true, list)
    expect(ids(r)).toEqual(list.slice(3).map((x) => x.session_id))
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

describe('folds', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })
  it('opens Continue and folds Releases and Saved by default', () => {
    expect(readFolds()).toEqual({ continue: false, releases: true, saved: true })
  })
  it('keeps them per device, each key falling back to its default', () => {
    keepFolds({ continue: true, releases: false, saved: true })
    expect(readFolds()).toEqual({ continue: true, releases: false, saved: true })
    localStorage.setItem(FOLDS_KEY, JSON.stringify({ releases: false, saved: 'no', other: true }))
    expect(readFolds()).toEqual({ ...DEFAULT_FOLDS, releases: false })
    localStorage.setItem(FOLDS_KEY, 'null')
    expect(readFolds()).toEqual(DEFAULT_FOLDS)
  })
  it('gives the defaults when storage throws, and keeping then does nothing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private mode') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('private mode') })
    expect(readFolds()).toEqual(DEFAULT_FOLDS)
    expect(() => keepFolds({ continue: true, releases: true, saved: true })).not.toThrow()
  })
})

describe('folded lines', () => {
  it('counts what Continue holds: waiting, working, idle; ended rows not at all', () => {
    expect(continueCounts([
      s('a', 'waiting-on-you', NOW), s('b', 'working', NOW), s('c', 'looping', NOW), s('d', 'idle', NOW),
      s('e', 'idle', NOW, { status: 'ended' }),
    ])).toEqual({ waiting: 1, working: 2, done: 0, idle: 1 })
  })
  it('says how many were saved and the newest, cut short', () => {
    const items = [
      { id: 1, text: 'older', files: [], created_at: NOW - 5000 },
      { id: 2, text: 'Limits on the phone home: 5-hour first, weekly after', files: [], created_at: NOW },
    ] as InboxItem[]
    const sum = savedSummary(items)
    expect(sum.count).toBe(2)
    expect(sum.newest?.id).toBe(2)
    expect(sum.text).toBe('Limits on the phone home: 5-hour first,…')
    expect(savedSummary([{ id: 3, text: '', files: [{}, {}], created_at: NOW } as unknown as InboxItem]).text).toBe('2 photos')
  })
})

describe('limitsGlance', () => {
  const sec = (ms: number) => Math.floor((NOW + ms) / 1000)
  it("says Claude Code's 5-hour window with its reset and the week, amber from 80% and red from 95%", () => {
    const g = limitsGlance({ rate_limits: { five_hour: { used_percentage: 82.4, resets_at: sec(80 * 60_000) }, seven_day: { used_percentage: 95, resets_at: sec(3 * 86_400_000) } } }, NOW)
    expect(g).toEqual({ agent: 'claude', five: { pct: 82, tone: 'warn', resetIn: '1h 20m' }, week: { pct: 95, tone: 'danger', resetIn: '3d 0h' } })
    expect(limitsGlance({ rate_limits: { five_hour: { used_percentage: 79, resets_at: sec(60_000) } } }, NOW)?.five?.tone).toBeUndefined()
  })
  it("falls back to Codex's windows only when Claude Code has none", () => {
    const codex = { five_hour: { used_percentage: 10, resets_at: sec(3_600_000) } }
    expect(limitsGlance({ codex_rate_limits: codex }, NOW)?.agent).toBe('codex')
    expect(limitsGlance({ rate_limits: { seven_day: { used_percentage: 3, resets_at: sec(86_400_000) } }, codex_rate_limits: codex }, NOW)?.agent).toBe('claude')
  })
  it('leaves out a window that has already reset, and the clock of one implausibly far ahead', () => {
    expect(limitsGlance({ rate_limits: { five_hour: { used_percentage: 90, resets_at: sec(-60_000) } } }, NOW)).toBeUndefined()
    expect(limitsGlance({ rate_limits: { seven_day: { used_percentage: 40, resets_at: sec(30 * 86_400_000) } } }, NOW))
      .toEqual({ agent: 'claude', five: undefined, week: { pct: 40, tone: undefined } })
    expect(limitsGlance(undefined, NOW)).toBeUndefined()
  })
  it('says a time to the reset short', () => {
    expect(shortIn(20_000)).toBe('1m')
    expect(shortIn(45 * 60_000)).toBe('45m')
    expect(shortIn(2 * 3_600_000)).toBe('2h')
    expect(shortIn(26 * 3_600_000)).toBe('1d 2h')
  })
})

describe('rowMeta', () => {
  const ctx = (pct: number) => ({ tokens: 1, window: 1, pct, next_call_usd: 0 })
  it('says the context and the subagents of a live row, hot from 80%', () => {
    expect(rowMeta(s('a', 'working', NOW, { context: ctx(84.2), live_subagents: 3 }))).toEqual({ ctx: 84, hot: true, subagents: 3 })
    expect(rowMeta(s('a', 'idle', NOW, { context: ctx(79.4) }))).toEqual({ ctx: 79, hot: false, subagents: 0 })
    expect(rowMeta(s('a', 'idle', NOW, { live_subagents: 2 }))).toEqual({ ctx: undefined, hot: false, subagents: 2 })
  })
  it('says nothing for an ended row, or one with neither', () => {
    expect(rowMeta(s('a', 'idle', NOW, { status: 'ended', context: ctx(90) }))).toBeUndefined()
    expect(rowMeta(s('a', 'idle', NOW))).toBeUndefined()
  })
})
