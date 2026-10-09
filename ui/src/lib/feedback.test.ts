/**
 * What gets attached to a report, and — more importantly — what does not.
 *
 * People install Caprock because nothing leaves their machine. A feedback
 * button that quietly carried project names or spend would break that promise
 * even with a click behind it, so the contents of the context block are pinned
 * here rather than left to whoever edits the file next.
 */
import { describe, expect, it } from 'vitest'
import { body, context, isSendable, issueURL, KINDS, title, type Report } from './feedback'
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

const report = (over: Partial<Report> = {}): Report => ({
  kind: 'bug',
  title: 'Cost chart is empty',
  text: 'after a restart the chart is blank',
  ctx: ['Caprock v0.10.1', 'Screen: Cost'],
  shots: 0,
  ...over,
})

const params = (u: string) => new URL(u).searchParams

describe('title', () => {
  it('is the user\'s own title, verbatim', () => {
    expect(title('the button is crooked')).toBe('the button is crooked')
    expect(params(issueURL(report())).get('title')).toBe('Cost chart is empty')
  })

  it('keeps one line and stays under GitHub\'s 256-character cap', () => {
    expect(title('add totals\nand also a chart')).toBe('add totals')
    const t = title('x'.repeat(400))
    expect(t.length).toBeLessThanOrEqual(256)
    expect(t).toContain('…')
  })
})

describe('body', () => {
  it('reproduces what the user typed, unaltered', () => {
    // No rewriting: their words are the report. Anything else needs a model,
    // and reaching for one would mean sending their text somewhere.
    const text = 'the button on History is crooked'
    expect(body(report({ text }))).toContain(text)
  })

  it('says the issue was not sent automatically', () => {
    expect(body(report()).toLowerCase()).toContain('nothing was sent automatically')
  })

  it('heads the section by what kind of report it is', () => {
    expect(body(report({ kind: 'bug' }))).toContain('What happened')
    expect(body(report({ kind: 'idea' }))).toContain('The idea')
    expect(body(report({ kind: 'question' }))).toContain('The question')
    expect(body(report({ kind: 'question' }))).not.toContain('What happened')
  })

  it('stands without a description: the title can be the whole report', () => {
    expect(body(report({ text: '' }))).toContain('see the title')
  })

  it('carries the diagnostics, or leaves them out when the box is unticked', () => {
    expect(body(report())).toContain('### Diagnostics')
    expect(body(report())).toContain('- Caprock v0.10.1')
    const without = body(report({ ctx: null }))
    expect(without).not.toContain('Diagnostics')
    expect(without).not.toContain('v0.10.1')
  })

  it('ends by asking for the screenshots a URL cannot carry', () => {
    const b = body(report({ shots: 2, pasteKey: 'Ctrl+V' }))
    expect(b.trim().split('\n').pop()).toBe('**Screenshots: 2 — paste them here (Ctrl+V).**')
    expect(body(report({ shots: 1 }))).toContain('Screenshots: 1 — paste it here (⌘V)')
    expect(body(report({ shots: 0 }))).not.toContain('Screenshots')
  })
})

describe('issueURL', () => {
  it('points at the product repo and carries a label', () => {
    const u = issueURL(report())
    expect(u).toContain('github.com/dspv/caprock/issues/new')
    expect(params(u).get('labels')).toBe('bug')
  })

  it('maps each kind to a label that exists on the repo', () => {
    // `gh label list -R dspv/caprock`, 2026-10-10. GitHub drops an unknown
    // label silently, so a typo here would file every report unlabelled.
    const existing = ['bug', 'enhancement', 'question']
    expect(KINDS.map((k) => k.id)).toEqual(['bug', 'idea', 'question'])
    for (const k of KINDS) {
      expect(existing).toContain(k.gh)
      expect(params(issueURL(report({ kind: k.id }))).get('labels')).toBe(k.gh)
    }
    expect(params(issueURL(report({ kind: 'idea' }))).get('labels')).toBe('enhancement')
  })

  it('escapes text that would otherwise break the URL', () => {
    const u = issueURL(report({ title: 'crash on "quotes" & #hashes', text: 'a & b # c' }))
    expect(() => new URL(u)).not.toThrow()
    expect(params(u).get('title')).toBe('crash on "quotes" & #hashes')
    expect(params(u).get('body')).toContain('a & b # c')
  })
})

describe('isSendable', () => {
  it('needs a title', () => {
    // An empty issue costs a maintainer more than it costs the reporter.
    for (const empty of ['', '   ', '\n', 'ok']) expect(isSendable(empty)).toBe(false)
    expect(isSendable('History is blank')).toBe(true)
  })
})

describe('a long report', () => {
  it('stays inside what a URL can carry', () => {
    // GitHub truncates a prefilled issue past roughly 8k; silently losing the
    // end of someone's report is worse than refusing it.
    const u = issueURL(report({ title: 't'.repeat(1000), text: 'x'.repeat(50000), shots: 4 }))
    expect(u.length).toBeLessThan(8000)
    expect(params(u).get('body')).toContain('truncated')
    expect(params(u).get('body')).toContain('Screenshots: 4')
  })
})
