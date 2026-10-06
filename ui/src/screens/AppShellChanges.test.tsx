/**
 * Which worktree the sidebar's ±N opens: the linked one by git's name, the
 * main checkout as '', with its latest agent session for the commit draft.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ProjectNode } from '@/lib/sidebar'
import { changesTargetOf } from './AppShell'

vi.mock('@/components/TerminalPane', () => ({ TerminalPane: () => null }))

const node = {
  project: { id: '4', root: '/w/app', name: 'app', kind: 'repo', branch: 'main' },
  costToday: 0, waiting: 0, looping: 0, live: 1, lastActive: 0,
  worktrees: [
    { key: 'main', branch: 'main', path: '/w/app', isMain: true, changed: 2, sessions: [] },
    {
      key: 'fix-login', branch: 'fix-login', path: '/w/app/.caprock-worktrees/fix-login', isMain: false, changed: 5,
      sessions: [
        { session: { session_id: 'sh' }, isShell: true },
        { session: { session_id: 'agent' }, isShell: false },
      ],
    },
  ],
} as unknown as ProjectNode

describe('changesTargetOf', () => {
  it('names a linked worktree and its latest agent', () => {
    expect(changesTargetOf(node, node.worktrees[1])).toEqual({ projectId: '4', worktree: 'fix-login', title: 'app · fix-login', sessionId: 'agent' })
  })
  it('opens the main checkout when none is named', () => {
    expect(changesTargetOf(node)).toEqual({ projectId: '4', worktree: '', title: 'app · main', sessionId: undefined })
  })
})
