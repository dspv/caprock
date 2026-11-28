import { describe, expect, it } from 'vitest'
import { caughtText, inviteKeyOf, looksLikeInvite, needsMe, stateLine, voiceOf, type TalkEntry } from './talks'
import { href, parseHash } from './router'
import { notifyRoute } from './shell'

const KEY = 'cj1-AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_QEFCQ0RFRkdISUpLTE1OT1BR'

function entry(side: 'me' | 'them', kind: TalkEntry['kind'], author: Partial<TalkEntry['envelope']['author']> = {}): TalkEntry {
  return {
    talk: 't', side, seq: 1, kind, hash: 'h', at: 0,
    envelope: { v: 1, kind, talk: 't', seq: 1, prev: '', body: 'hi', at: 0, author: { kind: kind === 'human' ? 'person' : 'agent', name: '', ...author } },
  }
}

describe('Talks', () => {
  it('reads the key from the whole link, or the key alone', () => {
    expect(inviteKeyOf(`https://caprock.dev/talk#${KEY}`)).toBe(KEY)
    expect(inviteKeyOf(`  ${KEY}\n`)).toBe(KEY)
    expect(looksLikeInvite(`https://caprock.dev/talk#${KEY}`)).toBe(true)
    expect(looksLikeInvite('https://caprock.dev/talk#nope')).toBe(false)
    expect(looksLikeInvite('hello')).toBe(false)
  })

  it('says what the guard caught in words', () => {
    expect(caughtText('never-share_term=1')).toBe('a never-share term')
    expect(caughtText('never-share_term=1 token=2')).toBe('a never-share term, 2 tokens')
    expect(caughtText('iban=1')).toBe('an iban')
    expect(caughtText('')).toBe('')
  })

  it('names three voices: my agent, theirs, and the two people', () => {
    expect(voiceOf(entry('me', 'message', { model: 'opus' }), 'Ana')).toEqual({ who: 'mine', label: 'Your agent · opus' })
    expect(voiceOf(entry('them', 'message'), 'Ana')).toEqual({ who: 'theirs', label: "Ana's agent" })
    expect(voiceOf(entry('me', 'human'), 'Ana')).toEqual({ who: 'me', label: 'You' })
    expect(voiceOf(entry('them', 'human'), 'Ana')).toEqual({ who: 'partner', label: 'Ana' })
    expect(voiceOf(entry('them', 'message', { edited: true }), 'Ana').label).toBe("Ana's agent · edited by Ana")
  })

  it('says whose move it is', () => {
    expect(stateLine({ state: 'held', hold: 'redaction', person_name: 'Ana' })).toBe('waiting for you')
    expect(stateLine({ state: 'held', hold: 'cap', person_name: 'Ana' })).toBe('stopped at your cap')
    expect(stateLine({ state: 'waiting', person_name: 'Ana' }, 'offline')).toContain('offline')
    expect(stateLine({ state: 'ended', ended_by: 'them', person_name: 'Ana' })).toBe('ended by Ana')
    expect(needsMe({ state: 'invited' })).toBe(true)
    expect(needsMe({ state: 'waiting' })).toBe(false)
  })

  it('has routes, and a hold notification may open its Talk', () => {
    expect(parseHash('#/talks')).toEqual({ name: 'talks' })
    expect(parseHash('#/talks?with=abc')).toEqual({ name: 'talks', with: 'abc' })
    expect(parseHash('#/talks/t_0123456789abcdef01234567')).toEqual({ name: 'talk', id: 't_0123456789abcdef01234567' })
    expect(href({ name: 'talks', with: 'a b' })).toBe('#/talks?with=a%20b')
    expect(href({ name: 'talk', id: 't_1' })).toBe('#/talks/t_1')
    expect(notifyRoute('#/talks/t_0123456789abcdef01234567')).toBe('#/talks/t_0123456789abcdef01234567')
    expect(notifyRoute('#/talks/../settings')).toBeNull()
  })
})
