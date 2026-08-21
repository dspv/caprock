/**
 * Projects panel — the per-repo spend roll-up on Now. Covers the parts that are
 * easy to get wrong: the live dot only lights for projects that actually have a
 * running session, the bar is a share of the largest project, and the panel
 * degrades to a plain message rather than a broken chart when there is no data.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

beforeEach(() => {
  // The measure choice persists across reloads, so it must not leak between
  // tests — a stale "tokens" would make the default-mode assertions lie.
  localStorage.clear()
})

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

/**
 * The $ / tokens toggle. On a subscription plan the dollar figure is a proxy
 * for consumption rather than money owed, so the panel must be able to make
 * tokens the headline — and everything scaled to the headline has to follow it,
 * or the picture contradicts the number beside it.
 */
describe('ProjectsPanel measure toggle', () => {
  // A project whose cost and token rankings DISAGREE, which is what makes the
  // toggle observable: a cheap model burns tokens cheaply, so the costliest
  // repository is not always the one that consumed most.
  const disagreeing: ProjectShare[] = [
    {
      project: 'pricey',
      tokens: 1_000_000,
      cost_usd: 900,
      sessions: 1,
      spark: { from_ms: 0, width_ms: 86_400_000, cost: [900, 0], tokens: [1_000_000, 0] },
    },
    {
      project: 'chatty',
      tokens: 9_000_000,
      cost_usd: 100,
      sessions: 1,
      spark: { from_ms: 0, width_ms: 86_400_000, cost: [0, 100], tokens: [0, 9_000_000] },
    },
  ]

  /**
   * The headline is the large accent figure and the sub-line the faint one
   * directly beneath it. Both are read from the row's NUMBER column — the
   * session count is styled the same and lives in the label column, so a
   * document-wide class lookup would pick it up instead.
   */
  function figures(row: HTMLElement): { headline: string; subline: string } {
    const col = row.lastElementChild as HTMLElement
    return {
      headline: col.querySelector('.text-\\[17px\\]')?.textContent ?? '',
      subline: col.querySelector('.text-\\[11px\\]')?.textContent ?? '',
    }
  }

  it('defaults to cost as the headline with tokens beneath', async () => {
    projects.value = disagreeing
    const { container } = render(<ProjectsPanel sessions={[]} />)
    await screen.findByText('pricey')
    const row = container.querySelectorAll('.grid-cols-\\[1fr_128px_auto\\]')[0] as HTMLElement
    expect(figures(row)).toEqual({ headline: '$900.00', subline: '1.00M' })
  })

  it('swaps the headline and the sub-line when tokens is selected', async () => {
    projects.value = disagreeing
    const { container } = render(<ProjectsPanel sessions={[]} />)
    await screen.findByText('pricey')
    fireEvent.click(screen.getByTitle(/show tokens as the headline/))
    const row = container.querySelectorAll('.grid-cols-\\[1fr_128px_auto\\]')[0] as HTMLElement
    // Tokens are now the large figure and cost the quiet one — the exact
    // inverse of the default.
    expect(figures(row)).toEqual({ headline: '1.00M', subline: '$900.00' })
  })

  it('restates the panel total in the selected measure', async () => {
    projects.value = disagreeing
    render(<ProjectsPanel sessions={[]} />)
    await screen.findByText('pricey')
    expect(screen.getByText('$1,000.00 total')).toBeTruthy()
    fireEvent.click(screen.getByTitle(/show tokens as the headline/))
    // 10M tokens, not the dollar total — a header still reading dollars while
    // the rows read tokens is two different answers to one question.
    expect(screen.getByText('10.00M total')).toBeTruthy()
  })

  it('re-scales the sparkline to the selected measure', async () => {
    projects.value = disagreeing
    const { container } = render(<ProjectsPanel sessions={[]} />)
    await screen.findByText('pricey')
    // The canvas states its own contents for assistive tech, which is also the
    // only readable assertion available: jsdom does not rasterise a canvas.
    const byCost = container.querySelector('canvas')?.getAttribute('aria-label') ?? ''
    expect(byCost).toContain('cost over time')
    fireEvent.click(screen.getByTitle(/show tokens as the headline/))
    const byTokens = container.querySelector('canvas')?.getAttribute('aria-label') ?? ''
    expect(byTokens).toContain('tokens over time')
  })

  it('scales the fallback bar on the selected measure when no series was sent', async () => {
    // range=all sends no spark, so the row keeps the share bar — and that bar
    // must follow the toggle too, or it would contradict the headline.
    projects.value = [
      { project: 'pricey', tokens: 1_000_000, cost_usd: 900, sessions: 1 },
      { project: 'chatty', tokens: 9_000_000, cost_usd: 100, sessions: 1 },
    ]
    const { container } = render(<ProjectsPanel sessions={[]} />)
    await screen.findByText('pricey')
    // Both rows' bars, in order. The bar is a share of the largest row IN THE
    // SELECTED MEASURE, so the toggle should swap which of the two is full.
    const widths = () =>
      Array.from(container.querySelectorAll('.bg-accent\\/70')).map((el) => (el as HTMLElement).style.width)
    // By cost `pricey` is the largest, so it fills and `chatty` is a ninth.
    expect(widths()).toEqual(['100%', `${(100 * 100) / 900}%`])
    fireEvent.click(screen.getByTitle(/show tokens as the headline/))
    // By tokens the ranking inverts: `chatty` now fills and `pricey` is a
    // ninth. A bar still scaled on cost would contradict the headline.
    expect(widths()).toEqual([`${(100 * 1_000_000) / 9_000_000}%`, '100%'])
  })

  it('remembers the measure across a remount', async () => {
    projects.value = disagreeing
    const first = render(<ProjectsPanel sessions={[]} />)
    await screen.findByText('pricey')
    fireEvent.click(screen.getByTitle(/show tokens as the headline/))
    first.unmount()

    const { container } = render(<ProjectsPanel sessions={[]} />)
    await screen.findByText('pricey')
    const row = container.querySelectorAll('.grid-cols-\\[1fr_128px_auto\\]')[0] as HTMLElement
    // How you are billed does not change between visits, so re-picking this
    // every reload would be a chore.
    expect(figures(row).headline).toBe('1.00M')
  })

  it('marks the selected measure as pressed for assistive tech', async () => {
    projects.value = disagreeing
    render(<ProjectsPanel sessions={[]} />)
    await screen.findByText('pricey')
    expect(screen.getByRole('button', { name: '$' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'tokens' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'tokens' }))
    expect(screen.getByRole('button', { name: 'tokens' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '$' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('shows a directory breakdown in the selected measure', async () => {
    projects.value = [
      {
        project: 'mono',
        tokens: 1_000_000,
        cost_usd: 300,
        sessions: 2,
        paths: [
          { path: 'ui', tokens: 900_000, cost_usd: 100, sessions: 1 },
          { path: 'cmd', tokens: 100_000, cost_usd: 200, sessions: 1 },
        ],
      },
    ]
    render(<ProjectsPanel sessions={[]} />)
    fireEvent.click(await screen.findByTitle('mono: show cost by directory'))
    expect(screen.getByText('$100.00')).toBeTruthy()
    fireEvent.click(screen.getByTitle(/show tokens as the headline/))
    // The parts must be stated in the same unit as the whole, or they cannot
    // be checked against it.
    expect(screen.getByText('900.0k')).toBeTruthy()
  })
})
