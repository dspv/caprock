import { describe, expect, it } from 'vitest'
import { junkReasons } from './junk'
import { MAIL_KEYS } from './keymap'

describe('junk filter in the UI', () => {
  it('names up to three reasons in words, strongest first, skipping unknown codes', () => {
    expect(junkReasons('provider-spam,nope,dmarc-fail,spf-fail,cheap-tld'))
      .toBe('your mail server marked it as spam, the sender’s domain does not vouch for it (DMARC), it came from a server the domain does not allow (SPF)')
    expect(junkReasons('')).toBe('')
    expect(junkReasons(undefined)).toBe('')
  })

  it('Not spam has a key of its own', () => {
    const used = Object.entries(MAIL_KEYS).filter(([, v]) => v === MAIL_KEYS.notSpam)
    expect(used.map(([k]) => k)).toEqual(['notSpam'])
  })
})
