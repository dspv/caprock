import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/lib/api'

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      subagents: async () => ({ working: [], finished: 0 }),
      todos: async () => ({ items: [], updated_at: 0 }),
      recentMainEvents: async () => [],
      permission: async () => ({ permission: null }),
      compaction: async () => ({ session_id: 'a1', running: false, queued: false }),
      sessionCalls: async () => [],
      overlap: async () => ({ window_minutes: 30, sessions: {} }),
      summary: async () => { throw new Error('no summary') },
      diff: async () => ({ root: '/w/app', branch: 'main', stat: '', files: [] }),
    },
  }
})

vi.mock('@/lib/live', async (orig) => {
  const actual = await orig<typeof import('@/lib/live')>()
  return { ...actual, useLive: () => ({ ...actual.useLive(), conn: 'open' }), useLiveConn: () => 'open' }
})

import { Inspector } from './Inspector'
import { agentInShell } from '@/lib/tablabels'

const shell = { session_id: 'sh1', kind: 'shell', cwd: '/w/app', status: 'active', owned: true, program: 'claude', agent_session_id: 'a1' } as unknown as SessionSummary
const inner = { session_id: 'a1', agent: 'claude', title: 'Fix the login page', cwd: '/w/app', status: 'active', started_at: new Date().toISOString(), tokens: {}, cost_usd: 1.25 } as unknown as SessionSummary

// Owner, 2026-11-20 (translated): "data went somewhere" — `claude --resume`
// typed into a shell tab, and the inspector showed only the shell.
describe('the inspector beside a shell running an agent session', () => {
  it('shows that session’s cockpit, says which shell it runs in, and keeps the shell’s actions', () => {
    render(<Inspector session={shell} sessionId="sh1" inside={inner} shellName="Shell 1" hasPermission={false} onClose={() => {}} onDetach={() => {}} />)
    const aside = screen.getByRole('complementary', { name: 'Inspector' })
    expect(within(aside).getByRole('heading', { level: 2 })).toHaveTextContent('Agent')
    expect(aside.textContent).toContain('Fix the login page')
    expect(aside.textContent).not.toContain('Login shell')
    expect(aside.querySelector('[data-runs-in-shell]')).toHaveTextContent('Runs in Shell 1')
    const host = screen.getByRole('region', { name: 'The shell: Shell 1' })
    expect(within(host).getByRole('button', { name: 'Close the shell' })).toBeInTheDocument()
    expect(within(host).getByRole('button', { name: 'Stop the shell…' })).toBeInTheDocument()
    // The dashboard link opens the agent session's page, not the shell's.
    expect(within(host).getByRole('link', { name: 'Open in the dashboard' }).getAttribute('href')).toContain('a1')
  })

  it('is the shell’s again once the agent exits', () => {
    const ended = { ...inner, status: 'ended' } as SessionSummary
    const found = agentInShell(shell, new Map([['a1', ended]]))
    expect(found).toBeUndefined()
    render(<Inspector session={shell} sessionId="sh1" inside={found} shellName="Shell 1" hasPermission={false} onClose={() => {}} onDetach={() => {}} />)
    const aside = screen.getByRole('complementary', { name: 'Inspector' })
    expect(within(aside).getByRole('heading', { level: 2 })).toHaveTextContent('Inspector')
    expect(aside.textContent).toContain('Login shell')
    expect(aside.querySelector('[data-runs-in-shell]')).toBeNull()
  })

  it('finds the session only while it runs, and only for a shell that names one', () => {
    const sessions = new Map([['a1', inner]])
    expect(agentInShell(shell, sessions)).toBe(inner)
    expect(agentInShell({ ...shell, agent_session_id: undefined } as SessionSummary, sessions)).toBeUndefined()
    expect(agentInShell(shell, new Map())).toBeUndefined()
    expect(agentInShell(undefined, sessions)).toBeUndefined()
  })
})
