/**
 * Watch (lib/watch.ts): which pasted links play, the embed's address, what is
 * kept in this browser, and which wait is new.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalLink, embedSrc, freshWaits, parseStart, parseYouTube, readWatchPrefs,
  saveWatchPrefs, waitKey, waitLine, withRecent, RECENT_MAX, type WaitItem,
} from './watch'

const ID = 'aqz-KE-bpKQ'
const LIST = 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'

describe('parseYouTube', () => {
  const cases: [string, ReturnType<typeof parseYouTube>][] = [
    [`https://www.youtube.com/watch?v=${ID}`, { video: ID }],
    [`youtube.com/watch?v=${ID}&t=1m30s`, { video: ID, start: 90 }],
    [`https://m.youtube.com/watch?v=${ID}&list=${LIST}`, { video: ID, list: LIST }],
    [`https://youtu.be/${ID}?t=42`, { video: ID, start: 42 }],
    [`https://www.youtube.com/shorts/${ID}`, { video: ID }],
    [`https://www.youtube.com/live/${ID}?si=abc`, { video: ID }],
    [`https://www.youtube-nocookie.com/embed/${ID}?start=10`, { video: ID, start: 10 }],
    [`https://www.youtube.com/playlist?list=${LIST}`, { list: LIST }],
    [`https://www.youtube.com/embed/videoseries?list=${LIST}`, { list: LIST }],
    [`  ${ID}  `, { video: ID }],
  ]
  for (const [input, want] of cases) {
    it(`reads ${input.trim()}`, () => expect(parseYouTube(input)).toEqual(want))
  }

  it('refuses what is not a YouTube video or playlist', () => {
    for (const bad of [
      '', 'hello', 'https://vimeo.com/123', `https://evil.example/watch?v=${ID}`,
      `https://www.youtube.com.evil.example/watch?v=${ID}`, 'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/@channel', `javascript:alert(1)//youtu.be/${ID}`, 'https://youtu.be/',
      `ftp://youtu.be/${ID}`,
    ]) expect(parseYouTube(bad)).toBe(null)
  })

  it('reads start times in every form YouTube writes', () => {
    expect(parseStart('90')).toBe(90)
    expect(parseStart('90s')).toBe(90)
    expect(parseStart('1h2m3s')).toBe(3723)
    expect(parseStart('2m')).toBe(120)
    expect(parseStart('soon')).toBeUndefined()
    expect(parseStart(null)).toBeUndefined()
  })
})

describe('embedSrc', () => {
  it('is the privacy-enhanced player, with the origin that may pause it', () => {
    const src = new URL(embedSrc({ video: ID, start: 5 }, 'http://127.0.0.1:22776'))
    expect(src.origin).toBe('https://www.youtube-nocookie.com')
    expect(src.pathname).toBe(`/embed/${ID}`)
    expect(src.searchParams.get('enablejsapi')).toBe('1')
    expect(src.searchParams.get('origin')).toBe('http://127.0.0.1:22776')
    expect(src.searchParams.get('start')).toBe('5')
    expect(src.searchParams.get('autoplay')).toBe('1')
  })

  it('plays a playlist on its own as a video series', () => {
    const src = new URL(embedSrc({ list: LIST }, 'http://127.0.0.1:1'))
    expect(src.pathname).toBe('/embed/videoseries')
    expect(src.searchParams.get('list')).toBe(LIST)
  })

  it('names no origin a page cannot have', () => {
    expect(new URL(embedSrc({ video: ID }, 'null')).searchParams.has('origin')).toBe(false)
  })
})

describe('what this browser keeps', () => {
  beforeEach(() => localStorage.clear())

  it('keeps one short form however a link was pasted', () => {
    expect(canonicalLink(parseYouTube(`https://www.youtube.com/watch?v=${ID}&t=90s`)!)).toBe(`https://youtu.be/${ID}?t=90`)
    expect(canonicalLink(parseYouTube(`youtu.be/${ID}`)!)).toBe(`https://youtu.be/${ID}`)
    expect(canonicalLink({ list: LIST })).toBe(`https://www.youtube.com/playlist?list=${LIST}`)
    // and reads it back as the same link
    expect(parseYouTube(canonicalLink({ video: ID, list: LIST, start: 3 }))).toEqual({ video: ID, list: LIST, start: 3 })
  })

  it('keeps the last few links, newest first, each once', () => {
    let r: string[] = []
    for (let i = 0; i < RECENT_MAX + 2; i++) r = withRecent(r, `https://youtu.be/${String(i).repeat(11).slice(0, 11)}`)
    expect(r).toHaveLength(RECENT_MAX)
    const again = withRecent(r, r[3]!)
    expect(again[0]).toBe(r[3])
    expect(again).toHaveLength(RECENT_MAX)
  })

  it('pauses by default, survives a reload, and shrugs off bad storage', () => {
    expect(readWatchPrefs()).toEqual({ recent: [], pause: true })
    saveWatchPrefs({ recent: [`https://youtu.be/${ID}`], pause: false })
    expect(readWatchPrefs()).toEqual({ recent: [`https://youtu.be/${ID}`], pause: false })
    localStorage.setItem('caprock.watch', '{not json')
    expect(readWatchPrefs()).toEqual({ recent: [], pause: true })
    localStorage.setItem('caprock.watch', JSON.stringify({ recent: ['https://evil.example/x', 7], pause: 'yes' }))
    expect(readWatchPrefs()).toEqual({ recent: [], pause: true })
  })
})

describe('the nudge', () => {
  const w = (sessionId: string, since: number, reason: WaitItem['reason'] = 'waiting'): WaitItem => ({ sessionId, title: `agent ${sessionId}`, reason, since })

  it('is for a wait that began after the tab opened, newest first, once', () => {
    const items = [w('old', 50), w('a', 150), w('b', 200, 'permission')]
    const fresh = freshWaits(new Set(), items, 100)
    expect(fresh.map((x) => x.sessionId)).toEqual(['b', 'a'])
    const seen = new Set(fresh.map(waitKey))
    expect(freshWaits(seen, items, 100)).toEqual([])
    // the same session waiting again later is a new wait
    expect(freshWaits(seen, [w('a', 300)], 100).map((x) => x.sessionId)).toEqual(['a'])
  })

  it('says which agent and why', () => {
    expect(waitLine(w('x', 1))).toBe('agent x is waiting for you')
    expect(waitLine(w('x', 1, 'permission'))).toBe('agent x needs your permission')
  })
})
