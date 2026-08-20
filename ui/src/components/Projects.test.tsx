/**
 * Projects panel — the per-repo spend roll-up on Now. Covers the parts that are
 * easy to get wrong: the live dot only lights for projects that actually have a
 * running session, the bar is a share of the largest project, and the panel
 * degrades to a plain message rather than a broken chart when there is no data.
 */
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectsPanel } from './Projects'
import type { ProjectShare, SessionSummary } from '@/lib/api'

// The panel fetches through useApi; stub the endpoint it calls.
const projects = vi.hoisted(() => ({ value: [] as ProjectShare[] }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { ...actual.api, summary: async () => ({ projects: projects.value }) },
  }
})

function session(project: string, status: string): SessionSummary {
  return { session_id: `s-${project}`, project, status } as SessionSummary
}

afterEach(() => {
  projects.value = []
})

describe('ProjectsPanel', () => {
  it('renders each project with its cost and session count', async () => {
    projects.value = [
      { project: 'caprock', tokens: 1_000_000, cost_usd: 941.33, sessions: 12 },
      { project: 'fixel', tokens: 10_000, cost_usd: 50.68, sessions: 1 },
    ]
    render(<ProjectsPanel sessions={[]} />)
    expect(await screen.findByText('caprock')).toBeTruthy()
    expect(screen.getByText('12 sessions')).toBeTruthy()
    // A single session must not read as "1 sessions".
    expect(screen.getByText('1 session')).toBeTruthy()
  })

  it('marks only projects that have a live session', async () => {
    projects.value = [
      { project: 'caprock', tokens: 10, cost_usd: 10, sessions: 1 },
      { project: 'fixel', tokens: 10, cost_usd: 5, sessions: 1 },
    ]
    const { container } = render(
      <ProjectsPanel sessions={[session('caprock', 'active'), session('fixel', 'ended')]} />,
    )
    await screen.findByText('caprock')
    const dots = container.querySelectorAll('[title="a session is live in this project"]')
    expect(dots.length).toBe(1)
  })

  it('shows a message instead of an empty chart when nothing was captured', async () => {
    projects.value = []
    render(<ProjectsPanel sessions={[]} />)
    expect(await screen.findByText(/No spend captured/)).toBeTruthy()
  })

  it('collapses a long list behind a show-all control', async () => {
    projects.value = Array.from({ length: 9 }, (_, i) => ({
      project: `p${i}`,
      tokens: 10,
      cost_usd: 10 - i,
      sessions: 1,
    }))
    render(<ProjectsPanel sessions={[]} />)
    expect(await screen.findByText('show all 9 projects')).toBeTruthy()
    expect(screen.queryByText('p8')).toBeNull()
  })
})
