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
          { path: '/ui', tokens: 100, cost_usd: 400, turns: 2 , tokens_pct: 0, cost_pct: 0 },
          { path: '/', tokens: 900, cost_usd: 1262, turns: 3 , tokens_pct: 0, cost_pct: 0 },
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
    expect(screen.getByText('· $400.00')).toBeTruthy()
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
        paths: [{ path: '.', tokens: 10, cost_usd: 10, turns: 1 , tokens_pct: 0, cost_pct: 0 }],
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
        { path: 'a', tokens: 5, cost_usd: 4, turns: 1 , tokens_pct: 0, cost_pct: 0 },
        { path: 'b', tokens: 5, cost_usd: 3, turns: 1 , tokens_pct: 0, cost_pct: 0 },
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
 * Both figures, always. The panel used to hide one behind a $ / tokens toggle;
 * it does not any more, so what has to hold is that every row states BOTH what
 * was consumed and what it was worth, that each number is the row's own, and
 * that the second one is large enough to read rather than being chrome.
 */
describe('ProjectsPanel figures', () => {
  // Cost and token rankings DISAGREE here, which is what makes each assertion
  // able to fail: a cheap model burns tokens cheaply, so the costliest
  // repository is not the one that consumed most, and anything reading the
  // wrong field or the wrong row lands on a different number.
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

  /** The two figures of one row, read from its NUMBER column. The session count
   *  is styled like the sub-line and lives in the label column, so a
   *  document-wide class lookup would pick it up instead. */
  function figures(row: HTMLElement): { tokens: string; cost: string } {
    const col = row.lastElementChild as HTMLElement
    return {
      tokens: col.querySelector('.text-\\[17px\\]')?.textContent ?? '',
      cost: col.querySelector('.text-\\[13px\\]')?.textContent ?? '',
    }
  }

  function rows(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll('.grid-cols-\\[1fr_128px_auto\\]')) as HTMLElement[]
  }

  it('states both tokens and cost on every row, each from its own project', async () => {
    projects.value = disagreeing
    const { container } = render(<ProjectsPanel sessions={[]} />)
    await screen.findByText('pricey')
    // Not just "both are present somewhere": each row carries ITS numbers, so a
    // row reading its neighbour's cost fails here.
    expect(rows(container).map(figures)).toEqual([
      { tokens: '1.00M', cost: '$900.00' },
      { tokens: '9.00M', cost: '$100.00' },
    ])
  })

  it('shows no control for choosing between the two figures', async () => {
    projects.value = disagreeing
    render(<ProjectsPanel sessions={[]} />)
    await screen.findByText('pricey')
    // The toggle is gone: nothing in the panel asks the reader to pick a unit.
    expect(screen.queryByRole('button', { name: 'tokens' })).toBeNull()
    expect(screen.queryByRole('button', { name: '$' })).toBeNull()
  })

  it('keeps the cost line at reading size rather than in the faint chrome tone', async () => {
    projects.value = disagreeing
    const { container } = render(<ProjectsPanel sessions={[]} />)
    await screen.findByText('pricey')
    // The complaint that removed the toggle was that the second figure was an
    // 11px `text-fg-faint` whisper. It must be neither.
    const col = rows(container)[0]!.lastElementChild as HTMLElement
    const cost = col.querySelector('.text-\\[13px\\]') as HTMLElement
    expect(cost.textContent).toBe('$900.00')
    expect(cost.className).toContain('text-fg-muted')
    expect(col.querySelector('.text-\\[11px\\]')).toBeNull()
    expect(col.querySelector('.text-fg-faint')).toBeNull()
  })

  it('totals both measures in the panel header', async () => {
    projects.value = disagreeing
    render(<ProjectsPanel sessions={[]} />)
    await screen.findByText('pricey')
    // 10M tokens and $1,000 — the header sums both columns beneath it, in the
    // same order as the rows. A header stating one would answer half the panel.
    expect(screen.getByText('10.00M')).toBeTruthy()
    expect(screen.getByText('· $1,000.00 total')).toBeTruthy()
  })

  it('plots and scales every picture on tokens, matching the leading figure', async () => {
    projects.value = disagreeing
    const { container } = render(<ProjectsPanel sessions={[]} />)
    await screen.findByText('pricey')
    // jsdom does not rasterise a canvas, so the picture states its own basis for
    // assistive tech and that is also the only readable assertion available.
    const labels = Array.from(container.querySelectorAll('canvas')).map((c) => c.getAttribute('aria-label'))
    expect(labels.every((l) => l?.includes('tokens over time'))).toBe(true)
  })

  it('scales the fallback bar on tokens when no series was sent', async () => {
    // range=all sends no spark, so the row keeps the share bar — and the bar
    // stands in for the sparkline, so it is scaled the same way.
    projects.value = disagreeing.map(({ spark: _spark, ...p }) => p)
    const { container } = render(<ProjectsPanel sessions={[]} />)
    await screen.findByText('pricey')
    const widths = Array.from(container.querySelectorAll('.bg-accent\\/70')).map(
      (el) => (el as HTMLElement).style.width,
    )
    // By tokens `chatty` is the largest and fills; `pricey` is a ninth. Scaled
    // on cost the two would be the other way round.
    expect(widths).toEqual([`${(100 * 1_000_000) / 9_000_000}%`, '100%'])
  })

  it('states both figures on each directory of the breakdown', async () => {
    projects.value = [
      {
        project: 'mono',
        tokens: 1_000_000,
        cost_usd: 300,
        sessions: 2,
        paths: [
          { path: 'ui', tokens: 900_000, cost_usd: 100, turns: 1, tokens_pct: 90, cost_pct: 33.3 },
          { path: 'cmd', tokens: 100_000, cost_usd: 200, turns: 1, tokens_pct: 10, cost_pct: 66.6 },
        ],
      },
    ]
    render(<ProjectsPanel sessions={[]} />)
    fireEvent.click(await screen.findByTitle('mono: show cost by directory'))
    // The parts are stated in the same units as the whole, or they cannot be
    // checked against it — and the row's three numbers must belong to one path.
    // The share sits with the tokens it describes, not between the two figures
    // where it would read as qualifying both.
    expect(screen.getByText('900.0k').parentElement?.textContent).toBe('900.0k 90% · $100.00')
    expect(screen.getByText('100.0k').parentElement?.textContent).toBe('100.0k 10% · $200.00')
  })

  it('names the two non-directory rows for what they are, never as a directory or a defect', async () => {
    // Carry-forward leaves exactly two rows that are not directories, and each
    // must satisfy two things at once: it must not read as a DIRECTORY (the
    // sentinel path never reaches the screen), and it must not read as a
    // FAILURE — the words describe the user's work, not the tool's bookkeeping.
    //
    //   - "outside the repository" is the large one on real data (26% of the
    //     owner's `amarketer`): work on THIS project whose files live
    //     elsewhere — Claude's notes, agent scratchpads, test output.
    //   - "repository-wide work" is now small and narrow: a session's opening
    //     turns, before any file was touched.
    //
    // Their shares must be visible too, so the column adds up.
    projects.value = [
      {
        project: 'mono',
        tokens: 1_000_000,
        cost_usd: 100,
        sessions: 2,
        paths: [
          { path: '/services/api', tokens: 600_000, cost_usd: 60, turns: 4, tokens_pct: 60, cost_pct: 60 },
          { path: '\u0000outside', tokens: 300_000, cost_usd: 30, turns: 20, outside: true, tokens_pct: 30, cost_pct: 30 },
          { path: '\u0000unattributed', tokens: 100_000, cost_usd: 10, turns: 2, unattributed: true, tokens_pct: 10, cost_pct: 10 },
        ],
      },
    ]
    render(<ProjectsPanel sessions={[]} />)
    fireEvent.click(await screen.findByTitle('mono: show cost by directory'))
    // The real directory keeps its path treatment.
    expect(screen.getByText('/services/api')).toBeTruthy()
    // Both rows say what the work IS, and neither sentinel reaches the screen.
    expect(screen.getByText('outside the repository')).toBeTruthy()
    expect(screen.getByText('repository-wide work')).toBeTruthy()
    expect(screen.queryByText('\u0000outside')).toBeNull()
    expect(screen.queryByText('\u0000unattributed')).toBeNull()
    // The word "unattributed" must not reach a user anywhere in the breakdown:
    // it describes the tool's bookkeeping rather than their work.
    expect(document.body.textContent).not.toMatch(/unattributed/i)
    // Each explanation rides on its own row, and they must say DIFFERENT things
    // — the whole point of splitting them is that the reasons differ.
    const outsideHover = screen.getByText('outside the repository').getAttribute('title') ?? ''
    expect(outsideHover).toMatch(/outside this repository/i)
    expect(outsideHover).toMatch(/scratchpad|notes|test-output/i)
    const wideHover = screen.getByText('repository-wide work').getAttribute('title') ?? ''
    expect(wideHover).toMatch(/before Claude had touched any file/i)
    expect(wideHover).not.toBe(outsideHover)
    // Their shares are stated rather than hidden in the denominator.
    expect(screen.getByText('300.0k').parentElement?.textContent).toBe('300.0k 30% · $30.00')
    expect(screen.getByText('100.0k').parentElement?.textContent).toBe('100.0k 10% · $10.00')
  })

  it('floors a share and never shows a real spend as a bare 0%', async () => {
    // Percentages floor: 99.9% is 99%, nothing reads as the whole until it is.
    // But a row with real money must not floor to "0%" — that would put a zero
    // beside a non-zero dollar figure on the same line.
    projects.value = [
      {
        project: 'mono',
        tokens: 1_000_000,
        cost_usd: 100,
        sessions: 1,
        paths: [
          { path: '/big', tokens: 999_000, cost_usd: 99.9, turns: 9, tokens_pct: 99.9, cost_pct: 99.9 },
          { path: '/tiny', tokens: 1_000, cost_usd: 0.1, turns: 1, tokens_pct: 0.04, cost_pct: 0.1 },
        ],
      },
    ]
    render(<ProjectsPanel sessions={[]} />)
    fireEvent.click(await screen.findByTitle('mono: show cost by directory'))
    // Floored, not rounded up to 100%.
    expect(screen.getByText('999.0k').parentElement?.textContent).toBe('999.0k 99% · $99.90')
    // A tiny but real share reads as smaller-than-expressible, not as nothing.
    expect(screen.getByText('1,000').parentElement?.textContent).toBe('1,000 <0.1% · $0.10')
  })

  it('scales a directory bar on the largest by tokens, not on the first row', async () => {
    // The daemon sorts the breakdown by COST, so the first path is not
    // necessarily the one with the most tokens; taking it as the scale would
    // push another row past 100%.
    projects.value = [
      {
        project: 'mono',
        tokens: 1_000_000,
        cost_usd: 300,
        sessions: 2,
        paths: [
          { path: 'cmd', tokens: 100_000, cost_usd: 200, turns: 1 , tokens_pct: 0, cost_pct: 0 },
          { path: 'ui', tokens: 900_000, cost_usd: 100, turns: 1 , tokens_pct: 0, cost_pct: 0 },
        ],
      },
    ]
    const { container } = render(<ProjectsPanel sessions={[]} />)
    fireEvent.click(await screen.findByTitle('mono: show cost by directory'))
    const widths = Array.from(container.querySelectorAll('.bg-accent\\/40')).map(
      (el) => (el as HTMLElement).style.width,
    )
    expect(widths).toEqual([`${(100 * 100_000) / 900_000}%`, '100%'])
  })
})
