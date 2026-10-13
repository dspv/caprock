import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import { promptTitle } from './sessionNames'
import { sessionTitle } from './sidebar'

const s = (p: Partial<SessionSummary>) => ({ session_id: 'x', status: 'active', git_branch: '', ...p }) as SessionSummary

describe('promptTitle', () => {
  it.each([
    ['can you please fix the login bug in auth.go', 'Fix the login bug'],
    ['I want you to add a dark mode toggle to settings', 'Add a dark mode toggle'],
    ['Refactor the billing worker. It is slow and nobody knows why', 'Refactor the billing worker'],
    ["let's look at ~/dev/caprock/internal/api/rename.go and tidy it", 'Look at rename.go'],
    ['  "review PR 532 — the sidebar rows"  ', 'Review PR 532'],
    ['list of open issues', 'List of open issues'],
    ['ok', 'Ok'],
    ['', ''],
  ])('%j → %j', (prompt, want) => {
    expect(promptTitle(prompt)).toBe(want)
  })

  it('takes the first line only', () => {
    expect(promptTitle('ship the release notes\nand then everything else')).toBe('Ship the release notes')
  })
})

describe('sessionTitle', () => {
  it('a name the user gave outranks the agent title and the prompt', () => {
    expect(sessionTitle(s({ name: 'Auth rewrite', title: 'Fix the login', description: 'Fix the login', description_source: 'title' }))).toBe('Auth rewrite')
  })
  it('with no name, the agent title', () => {
    expect(sessionTitle(s({ title: 'Fix the login', description: 'Fix the login', description_source: 'title' }))).toBe('Fix the login')
  })
  it('with no title, a few words of the first prompt rather than all of it', () => {
    expect(sessionTitle(s({ description: 'could you please migrate the sessions table to the new schema and backfill it', description_source: 'prompt' }))).toBe('Migrate the sessions table')
  })
  it('a name cleared since the list came keeps no stale description', () => {
    expect(sessionTitle(s({ name: '', description: 'Old name', description_source: 'name', git_branch: 'feat/x' }))).toBe('on feat/x')
  })
})
