import { describe, expect, it } from 'vitest'
import { safeHref, splitLinks, trimUrl } from './autolink'

const links = (s: string) => splitLinks(s).filter((p) => p.href).map((p) => p.text)

describe('a bare address in prose', () => {
  it('is found whole, with its fragment and query', () => {
    expect(links('See https://github.com/dspv/caprock/pull/768#issuecomment-6322183824 for it'))
      .toEqual(['https://github.com/dspv/caprock/pull/768#issuecomment-6322183824'])
    expect(links('the artifact https://claude.ai/artifact/XUWK6T8BAtS4msXnSYrbyY'))
      .toEqual(['https://claude.ai/artifact/XUWK6T8BAtS4msXnSYrbyY'])
    expect(links('search https://example.com/q?a=1&b=two%20words#top done')).toEqual(['https://example.com/q?a=1&b=two%20words#top'])
  })

  it('leaves the sentence its punctuation', () => {
    expect(links('Open https://example.com/a.')).toEqual(['https://example.com/a'])
    expect(links('https://a.example/x, https://b.example/y; and https://c.example/z!')).toEqual(['https://a.example/x', 'https://b.example/y', 'https://c.example/z'])
    expect(links('Here: https://example.com/a:')).toEqual(['https://example.com/a'])
    expect(links('«https://example.com/café»')).toEqual(['https://example.com/café'])
    expect(links('"https://example.com/q?x=1"')).toEqual(['https://example.com/q?x=1'])
    expect(links('Is it https://example.com/λόγος?')).toEqual(['https://example.com/λόγος'])
    expect(links('wait https://example.com/a...')).toEqual(['https://example.com/a'])
  })

  it('keeps a bracket the address opened and drops one the sentence did', () => {
    expect(links('(see https://example.com/a)')).toEqual(['https://example.com/a'])
    expect(links('(see https://en.wikipedia.org/wiki/Go_(game))')).toEqual(['https://en.wikipedia.org/wiki/Go_(game)'])
    expect(links('https://en.wikipedia.org/wiki/Go_(game).')).toEqual(['https://en.wikipedia.org/wiki/Go_(game)'])
    expect(links('[https://example.com/a]')).toEqual(['https://example.com/a'])
    expect(trimUrl('https://example.com/a)).')).toBe('https://example.com/a')
  })

  it('keeps the text around it as it was', () => {
    const s = 'One https://example.com/a. Two http://example.org/b, end'
    expect(splitLinks(s).map((p) => p.text).join('')).toBe(s)
    expect(splitLinks('no links here')).toEqual([{ text: 'no links here' }])
  })

  it('is only ever http or https', () => {
    expect(links('javascript:alert(1) file:///etc/passwd data:text/html,x ftp://example.com/a')).toEqual([])
    expect(links('xhttps://example.com and https:// alone')).toEqual([])
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('https://example.com/a b')).toBe('https://example.com/a%20b')
    expect(safeHref('HTTPS://Example.com/A')).toBe('https://example.com/A')
  })
})
