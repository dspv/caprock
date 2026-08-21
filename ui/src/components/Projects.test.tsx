/**
 * Projects panel — the per-repo spend roll-up on Now. Covers the parts that are
 * easy to get wrong: the live dot only lights for projects that actually have a
 * running session, the bar is a share of the largest project, and the panel
 * degrades to a plain message rather than a broken chart when there is no data.
 */
import { fireEvent, render, screen } from '@testing-library/react'
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

  it('expands a repository into its per-directory breakdown', async () => {
    projects.value = [
      {
        project: 'caprock',
        tokens: 1_000,
        cost_usd: 1662,
        sessions: 5,
        paths: [
          { path: '/ui', tokens: 100, cost_usd: 400, sessions: 2 },
          { path: '/', tokens: 900, cost_usd: 1262, sessions: 3 },
        ],
      },
    ]
    render(<ProjectsPanel sessions={[]} />)
    const row = await screen.findByTitle('caprock: show cost by directory')
    // Collapsed by default: the repository is the number that matters.
    expect(screen.queryByText('/ui')).toBeNull()
    expect(row.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(row)
    expect(screen.getByText('/ui')).toBeTruthy()
    expect(screen.getByText('$400.00')).toBeTruthy()
    // Work at the repository root reads as the root path, so the column is a
    // list of paths rather than a mix of paths and a special-case word.
    expect(screen.getByText('/')).toBeTruthy()
    expect(row.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(row)
    expect(screen.queryByText('/ui')).toBeNull()
  })

  it('offers no breakdown for a repository with a single directory', async () => {
    projects.value = [
      {
        project: 'solo',
        tokens: 10,
        cost_usd: 10,
        sessions: 1,
        paths: [{ path: '.', tokens: 10, cost_usd: 10, sessions: 1 }],
      },
    ]
    render(<ProjectsPanel sessions={[]} />)
    await screen.findByText('solo')
    // One directory is not a breakdown — it would restate the row's own total.
    expect(screen.queryByTitle('solo: show cost by directory')).toBeNull()
  })

  it('expands a repository without disturbing the show-all control', async () => {
    // The panel already had a "show all N projects" expander; the per-row
    // expansion is a separate control and the two must not fight.
    projects.value = Array.from({ length: 9 }, (_, i) => ({
      project: `p${i}`,
      tokens: 10,
      cost_usd: 10 - i,
      sessions: 1,
      paths: [
        { path: 'a', tokens: 5, cost_usd: 4, sessions: 1 },
        { path: 'b', tokens: 5, cost_usd: 3, sessions: 1 },
      ],
    }))
    render(<ProjectsPanel sessions={[]} />)
    const showAll = await screen.findByText('show all 9 projects')
    fireEvent.click(await screen.findByTitle('p0: show cost by directory'))
    // Expanding a row must not reveal the projects the list is hiding.
    expect(screen.queryByText('p8')).toBeNull()
    expect(showAll.textContent).toBe('show all 9 projects')
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
