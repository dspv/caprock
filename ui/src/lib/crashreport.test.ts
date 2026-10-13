import { describe, expect, it } from 'vitest'
import { listedJobs, type SessionRepoCI } from './api'
import { crashIssueURL, crashMailURL, describeCrash, resetViewState, scrub } from './crashreport'

describe('listedJobs', () => {
  // 0.115.1 sent `"jobs": null` for a release run with no jobs listed yet,
  // and the app's deck went black on every launch reading `.some` on it.
  it('turns a null job list into an empty one, release and branch runs alike', () => {
    const d = { release: { run: { id: 1, jobs: null } }, ci: { runs: [{ id: 2, jobs: null }, { id: 3, jobs: [{ id: 9 }] }] } } as unknown as SessionRepoCI
    listedJobs(d)
    expect(d.release!.run!.jobs).toEqual([])
    expect(d.ci!.runs[0]!.jobs).toEqual([])
    expect(d.ci!.runs[1]!.jobs).toHaveLength(1)
  })
})

describe('crash reports', () => {
  it('folds home directories and the local origin out of what is sent', () => {
    expect(scrub('open /Users/ada/dev/x failed')).toBe('open ~/dev/x failed')
    expect(scrub('at /home/ada/x')).toBe('at ~/x')
    expect(scrub('C:\\Users\\Ada\\repo')).toBe('~\\repo')
    expect(scrub('at http://127.0.0.1:4173/assets/AppShell.js:6:10')).toBe('at /assets/AppShell.js:6:10')
  })

  it('names the screen without its query, and carries no path', () => {
    const e = new TypeError("Cannot read properties of null (reading 'some') in /Users/ada/dev/repo")
    const c = describeCrash(e, '\n    at SessionDeck\n    at AppShell', '#/file?path=/Users/ada/secret.txt')
    const all = c.lines.join('\n')
    expect(all).toContain('Screen: #/file')
    expect(all).not.toContain('secret')
    expect(all).not.toContain('/Users/ada')
    expect(all).toContain('Component: at SessionDeck')
  })

  it('opens a prefilled issue and a short email, nothing sent on its own', () => {
    const c = describeCrash(new Error('boom'), null, '#/app')
    const issue = new URL(crashIssueURL(c))
    expect(issue.host).toBe('github.com')
    expect(issue.searchParams.get('labels')).toBe('bug')
    expect(issue.searchParams.get('body')).toContain('Error: Error: boom')
    const mail = crashMailURL(c)
    expect(mail.startsWith('mailto:hi@caprock.dev?')).toBe(true)
    expect(mail.length).toBeLessThan(6000)
  })

  it('a reset forgets caches and the deck view, never tabs or settings', () => {
    localStorage.clear()
    for (const k of ['caprock-swr-v1:summary', 'caprock.deck.ciView', 'caprock.app.deck', 'caprock.app.workspace.v1', 'caprock-theme']) localStorage.setItem(k, 'x')
    expect(resetViewState()).toBe(3)
    expect(Object.keys(localStorage).sort()).toEqual(['caprock-theme', 'caprock.app.workspace.v1'])
  })
})
