/**
 * What gets attached to a report, and — more importantly — what does not.
 *
 * People install Caprock because nothing leaves their machine. A feedback
 * button that quietly carried project names or spend would break that promise
 * even with a click behind it, so the contents of the context block are pinned
 * here rather than left to whoever edits the file next.
 */
import { describe, expect, it } from 'vitest'
import { body, context, isSendable, issueURL, title } from './feedback'
import type { Status } from './api'

const status = {
  version: 'v0.10.1',
  platform: 'darwin/arm64',
  events: 188418,
  owned_active: 2,
  orchestration: false,
  data_dir: '/Users/somebody/Library/Application Support/caprock',
  hooks: {
    settings_path: '/Users/somebody/.claude/settings.json',
    shim_path: '/Users/somebody/.caprock/caprock-hook',
    installed: ['PreToolUse'],
    missing: null,
    shim_exists: true,
  },
} as unknown as Status

describe('context', () => {
  it('carries what makes a report reproducible', () => {
    const c = context(status, 'History').join('\n')
    expect(c).toContain('v0.10.1')
    expect(c).toContain('darwin/arm64')
    expect(c).toContain('History')
    expect(c).toContain('188,418')
    expect(c).toContain('Hooks: installed')
  })

  it('never carries the data directory or hook paths', () => {
    // Those contain the user's name. A crooked button can be fixed without it.
    const c = context(status, 'Now').join('\n')
    expect(c).not.toContain('somebody')
    expect(c).not.toContain('/Users/')
    expect(c).not.toContain('.claude')
  })

  it('never carries project names or money', () => {
    const c = context(status, 'Cost').join('\n')
    expect(c).not.toMatch(/\$/)
    expect(c.toLowerCase()).not.toContain('cost_usd')
  })

  it('still produces something before the daemon has answered', () => {
    expect(context(undefined, 'Now')).toEqual(['Screen: Now'])
  })

  it('distinguishes a partial hook install, which changes which path ran', () => {
    const partial = { ...status, hooks: { ...status.hooks, missing: ['Stop'] } } as unknown as Status
    expect(context(partial, 'Now').join('\n')).toContain('partly installed')
  })
})

describe('title', () => {
  it('names the kind and the screen, then the user\'s own words', () => {
    expect(title('bug', 'History', 'the button is crooked')).toBe('[bug] History: the button is crooked')
  })

  it('truncates a long first line rather than filling the list with it', () => {
    const long = 'x'.repeat(200)
    const t = title('bug', 'Now', long)
    expect(t.length).toBeLessThan(80)
    expect(t).toContain('…')
  })

  it('uses only the first line, since the rest belongs in the body', () => {
    expect(title('feature', 'Cost', 'add totals\nand also a chart')).toBe('[feature] Cost: add totals')
  })
})

describe('body', () => {
  it('reproduces what the user typed, unaltered', () => {
    // No rewriting: their words are the report. Anything else needs a model,
    // and reaching for one would mean sending their text somewhere.
    const text = 'кнопка косая на History'
    expect(body('bug', text, ['Caprock v0.10.1'])).toContain(text)
  })

  it('says the issue was not sent automatically', () => {
    const b = body('bug', 'something', [])
    expect(b.toLowerCase()).toContain('nothing was sent automatically')
  })

  it('heads the section by what kind of report it is', () => {
    expect(body('bug', 'x', [])).toContain('What happened')
    expect(body('feature', 'x', [])).toContain('What is missing')
    expect(body('unclear', 'x', [])).toContain('What is unclear')
    // `other` is the catch-all, so it must not fall through to a bug heading —
    // a maintainer reading "What happened" assumes something broke.
    expect(body('other', 'x', [])).toContain('Feedback')
    expect(body('other', 'x', [])).not.toContain('What happened')
  })
})

describe('issueURL', () => {
  it('points at the product repo and carries a label', () => {
    const u = issueURL('bug', 'Now', 'it broke', ['Caprock v0.10.1'])
    expect(u).toContain('github.com/dspv/caprock/issues/new')
    expect(u).toContain('labels=bug')
  })

  it('maps a feature request to the label a maintainer filters on', () => {
    expect(issueURL('feature', 'Now', 'add a thing', [])).toContain('labels=enhancement')
  })

  it('escapes text that would otherwise break the URL', () => {
    const u = issueURL('bug', 'Now', 'crash on "quotes" & #hashes', [])
    expect(() => new URL(u)).not.toThrow()
    expect(new URL(u).searchParams.get('title')).toContain('quotes')
  })
})

describe('isSendable', () => {
  it('refuses a report with nothing in it', () => {
    // An empty issue costs a maintainer more than it costs the reporter.
    for (const empty of ['', '   ', '\n', 'ok']) {
      expect(isSendable(empty)).toBe(false)
    }
  })

  it('accepts a real sentence', () => {
    expect(isSendable('the History screen is blank')).toBe(true)
  })
})

describe('a long report', () => {
  it('stays inside what a URL can carry', () => {
    // GitHub truncates a prefilled issue past roughly 8k; silently losing the
    // end of someone's report is worse than refusing it.
    const long = 'x'.repeat(50000)
    const u = issueURL('bug', 'History', long, ['Caprock v0.10.1', 'Screen: History'])
    expect(u.length).toBeLessThan(8000)
    expect(decodeURIComponent(u)).toContain('truncated')
  })
})
