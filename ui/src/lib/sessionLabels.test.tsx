/**
 * Owner reports, 2026-10-05: two sessions in ~/Downloads/caprock and one in
 * ~/dev/caprock read as one project counted twice; a folder that is not a
 * repository showed "HEAD" as its branch; and an ended session's card said
 * "idle". The rules live in lib/sessionLabels.ts, and the Now card uses them.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import { branchLabel, projectLabels, sessionHealth, uniqueSuffixes } from './sessionLabels'
import { SessionCard } from '@/screens/Now'
import { dotOf, sessionTitle } from './sidebar'

function sess(p: Partial<SessionSummary>): SessionSummary {
  return {
    session_id: '35ce4532-0000-0000-0000-000000000000', cwd: '/Users/me/Downloads/caprock', project: 'caprock', model: '', started_at: 0, last_event_at: 0,
    status: 'idle', transcript_path: '', has_hooks: true, has_transcript: true, git_branch: 'main', version: '', owned: false,
    stats: { session_id: 's', turns: 0, tool_calls: 0, files_touched: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0 },
    activity: { phrase: 'was responding', at: '', health: 'idle' },
    savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 },
    ...p,
  } as SessionSummary
}

describe('shortest unique path suffix', () => {
  it('tells same-named folders apart with as little path as it takes', () => {
    const m = uniqueSuffixes(['/Users/me/Downloads/caprock', '/Users/me/dev/caprock', '/Users/me/dev/other'])
    expect(m.get('/Users/me/Downloads/caprock')).toBe('Downloads/caprock')
    expect(m.get('/Users/me/dev/caprock')).toBe('dev/caprock')
    expect(m.get('/Users/me/dev/other')).toBe('other')
    const deep = uniqueSuffixes(['/a/x/dev/caprock', '/b/x/dev/caprock'])
    expect([...deep.values()].sort()).toEqual(['a/x/dev/caprock', 'b/x/dev/caprock'])
  })

  it('labels a session only when its project name is shared by another folder', () => {
    const labels = projectLabels([
      sess({ session_id: 'a', cwd: '/Users/me/Downloads/caprock' }),
      sess({ session_id: 'b', cwd: '/Users/me/Downloads/caprock' }),
      sess({ session_id: 'c', cwd: '/Users/me/dev/caprock/ui', repo_root: '/Users/me/dev/caprock' }),
      sess({ session_id: 'd', cwd: '/w/solo', project: 'solo' }),
    ])
    expect(labels.get('a')).toBe('Downloads/caprock')
    expect(labels.get('b')).toBe('Downloads/caprock')
    expect(labels.get('c')).toBe('dev/caprock')
    expect(labels.has('d')).toBe(false)
  })
})

describe('branch and state', () => {
  it('never names HEAD as a branch', () => {
    expect(branchLabel('HEAD')).toBe('')
    expect(branchLabel('main')).toBe('main')
    expect(sessionTitle(sess({ title: '', description: '', git_branch: 'HEAD' }))).toBe('new session')
  })

  it('an ended session is ended, whatever its last narration said', () => {
    const s = sess({ status: 'ended', activity: { phrase: 'was responding', at: '', health: 'idle' } })
    expect(sessionHealth(s)).toBe('ended')
    expect(dotOf(s, true)).toBe('ended')
    expect(sessionHealth(sess({}))).toBe('idle')
  })
})

describe('the Now card', () => {
  it('says ended for an ended session, hides HEAD, and leads with what the session was about', () => {
    render(
      <SessionCard
        s={sess({ status: 'ended', git_branch: 'HEAD', description: 'Check the progress', description_source: 'title' })}
        now={Date.now()}
        projectLabel="Downloads/caprock"
      />,
    )
    expect(screen.getByText('ended')).toBeInTheDocument()
    expect(screen.queryByText('idle')).not.toBeInTheDocument()
    expect(screen.queryByText('HEAD')).not.toBeInTheDocument()
    expect(screen.getByText('Downloads/caprock')).toBeInTheDocument()
    expect(screen.getByText('Check the progress')).toHaveClass('font-medium')
    expect(screen.getByText('35ce4532')).toBeInTheDocument()
  })
})
