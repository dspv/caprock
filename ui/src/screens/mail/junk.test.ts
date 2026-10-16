import { describe, expect, it } from 'vitest'
import { filterFirst, isSpam, junkReasons, spamWhy } from './junk'
import { MAIL_KEYS } from './keymap'

describe('junk filter in the UI', () => {
  it('names up to three reasons in words, strongest first, skipping unknown codes', () => {
    expect(junkReasons('provider-spam,nope,dmarc-fail,spf-fail,cheap-tld'))
      .toBe('your mail server marked it as spam, the sender’s domain does not vouch for it (DMARC), it came from a server the domain does not allow (SPF)')
    expect(junkReasons('')).toBe('')
    expect(junkReasons(undefined)).toBe('')
  })

  it('spam is either source, and the note names whichever applies', () => {
    const ai = { category: 'spam' as const, at: 1 }
    expect(isSpam({ junk: true })).toBe(true)
    expect(isSpam({ ai })).toBe(true)
    expect(isSpam({ ai: { ...ai, category: 'important' } })).toBe(false)
    expect(spamWhy({ junk: true, junk_why: 'dmarc-fail', ai })).toMatch(/^Caprock’s junk filter and the AI both call this spam: the sender’s domain/)
    expect(spamWhy({ junk: true, junk_why: 'spf-fail' })).toMatch(/^Caprock thinks this is junk: it came from/)
    expect(spamWhy({ ai })).toMatch(/^The AI sorted this as spam/)
    expect(filterFirst([{ junk: false, n: 1 }, { junk: true, n: 2 }]).map((m) => m.n)).toEqual([2, 1])
  })

  it('Not spam has a key of its own', () => {
    const used = Object.entries(MAIL_KEYS).filter(([, v]) => v === MAIL_KEYS.notSpam)
    expect(used.map(([k]) => k)).toEqual(['notSpam'])
  })
})
