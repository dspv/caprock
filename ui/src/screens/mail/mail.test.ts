import { describe, expect, it } from 'vitest'
import { parseHash, href } from '@/lib/router'
import { mailEligible, NUDGE_PRIORITY } from '@/lib/nudges'
import { groupThreads } from './MailScreen'
import { buildDoc, hasRemoteContent } from './MailBody'
import { parseAddresses, quote, replySubject } from './format'
import type { Message } from './mailApi'
import { removeAccountPrompt } from './mailApi'

const msg = (p: Partial<Message>): Message => ({
  id: 1, account_id: 1, folder_id: 1, uid: 1, message_id: '', in_reply_to: '', references: '', thread_key: '',
  subject: 's', from_name: 'Ana', from_addr: 'ana@x.io', to: [], cc: [], reply_to: '', date: 0, size: 0,
  seen: true, flagged: false, answered: false, has_attach: false, snippet: '', structure: { parts: [] }, body_state: 1, ...p,
})

describe('mail', () => {
  it('routes #/mail both ways', () => {
    expect(parseHash('#/mail')).toEqual({ name: 'mail' })
    expect(href({ name: 'mail' })).toBe('#/mail')
  })

  it('offers Mail only after real use and only without an account', () => {
    expect(mailEligible(undefined, 0)).toBe(false)
    expect(mailEligible({ days: 1 }, 0)).toBe(false)
    expect(mailEligible({ days: 2 }, 0)).toBe(true)
    expect(mailEligible({ days: 9 }, 1)).toBe(false)
    expect(mailEligible({ days: 9 }, undefined)).toBe(false)
    expect(NUDGE_PRIORITY.mail).toBeGreaterThan(NUDGE_PRIORITY.star)
  })

  it('groups a thread into one row, newest first, carrying unread and star', () => {
    const rows = groupThreads([
      msg({ id: 3, thread_key: 'a', seen: false }),
      msg({ id: 2, thread_key: 'b' }),
      msg({ id: 1, thread_key: 'a', flagged: true }),
    ])
    expect(rows.map((r) => r.m.id)).toEqual([3, 2])
    expect(rows[0]).toMatchObject({ ids: [3, 1], count: 2, unread: true, flagged: true })
  })

  it('keeps remote images out until allowed', () => {
    const m = msg({ id: 7, body_html: '<img src="https://t.example/p.gif"><img src="cid:logo">' })
    expect(hasRemoteContent(m.body_html!)).toBe(true)
    const blocked = buildDoc(m, 'http://127.0.0.1:4173', false)
    expect(blocked).toContain("img-src data: http://127.0.0.1:4173;")
    expect(blocked).toContain("default-src 'none'")
    expect(blocked).toContain('/v1/mail/messages/7/part/cid%3Alogo')
    expect(buildDoc(m, 'http://127.0.0.1:4173', true)).toContain('https: http:')
  })

  it('parses recipients and builds replies', () => {
    expect(parseAddresses('Ana <ana@x.io>, bo@y.io')).toEqual([{ name: 'Ana', addr: 'ana@x.io' }, { name: '', addr: 'bo@y.io' }])
    expect(replySubject('Re: hi', 'Re')).toBe('Re: hi')
    expect(replySubject('hi', 'Fwd')).toBe('Fwd: hi')
    expect(quote(msg({ body_text: 'one\ntwo\n\n' })).endsWith('> one\n> two')).toBe(true)
  })
})

describe('removing an account', () => {
  it('says what happens to the sign-in at the provider', () => {
    expect(removeAccountPrompt({ email: 'a@x.io', auth: 'password' })).toBe('Remove a@x.io? Mail stays on the server.')
    expect(removeAccountPrompt({ email: 'a@gmail.com', auth: 'oauth2:google' })).toContain('gives back its access to this Google account')
    expect(removeAccountPrompt({ email: 'a@outlook.com', auth: 'oauth2:microsoft' })).toContain('account.live.com/consent/Manage')
  })
})
