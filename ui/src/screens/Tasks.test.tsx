/**
 * Tasks — the board, and what a finished task is finally able to show.
 *
 * The decision these pin is that a task stops being a title, an id and a dollar
 * figure. The work has always existed — a branch, a worktree, a diff behind an
 * endpoint, verification rows in SQLite — and none of it was ever on screen, so
 * the honest read of the feature was "it does nothing visible". Each test below
 * asserts one of those four facts is reachable from the card.
 *
 * The off-state is pinned too: it is the only thing most people will ever see of
 * this feature, and it used to name a flag without naming the concept.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TasksScreen } from './Tasks'
import type { DiffResult, Status, Task, TaskDetail } from '@/lib/api'

const state = vi.hoisted(() => ({
  status: {} as Partial<Status>,
  tasks: [] as Task[],
  detail: {} as TaskDetail,
  diff: undefined as DiffResult | undefined,
  // Every (hive, repo) pair POST /v1/hive was called with. The off state's whole
  // job is that this stays empty until the user confirms.
  enabled: [] as [string, string][],
}))
const enabled = state.enabled

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => state.status as Status,
      tasks: async () => state.tasks,
      task: async () => state.detail,
      diff: async () => state.diff as DiffResult,
      enableHive: async (hive?: string, repo?: string) => {
        state.enabled.push([hive ?? '', repo ?? ''])
        state.status = { ...state.status, orchestration: true }
        return { hive: hive ?? '', repo: repo ?? '' }
      },
    },
  }
})

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't-1755000000000-1', title: 'Add /healthz', status: 'done', assignee: 'worker-1',
    budget_usd: 3, verify_rounds: 1, cost_usd: 0.42, created_at: 0, updated_at: 0, ...over,
  }
}

afterEach(() => {
  state.status = {}
  state.tasks = []
  state.detail = {} as TaskDetail
  state.diff = undefined
  state.enabled.length = 0
})

describe('the off state', () => {
  it('explains the three things that decide whether you would run it', async () => {
    state.status = { orchestration: false } as Status
    render(<TasksScreen />)
    // Where the work happens, who runs the checks, and that the directory is new.
    expect(await screen.findByText(/own git worktree/)).toBeTruthy()
    expect(screen.getByText(/runs your commands, not the agent/)).toBeTruthy()
    expect(screen.getByText(/created for you/)).toBeTruthy()
  })

  // The point of the rewrite: the concept arrives as three labelled steps, not
  // as paragraphs. A user should be able to take it in without reading prose.
  it('is three steps, not prose, and never says "Phase 2" or "hive"', async () => {
    state.status = { orchestration: false } as Status
    const { container } = render(<TasksScreen />)
    expect(await screen.findByText('You write a task')).toBeTruthy()
    expect(screen.getByText('Caprock runs it')).toBeTruthy()
    expect(screen.getByText('Caprock checks it')).toBeTruthy()
    expect(container.textContent).not.toContain('Phase 2')
    expect(container.textContent).not.toContain('hive')
  })

  // Handing someone a command to paste into a terminal is not a start button.
  it('offers a button rather than a command to copy', async () => {
    state.status = { orchestration: false } as Status
    const { container } = render(<TasksScreen />)
    expect(await screen.findByRole('button', { name: /Turn on the task runner/ })).toBeTruthy()
    expect(container.textContent).not.toContain('caprock up --hive')
  })

  // Turning this on is what lets Caprock spawn Claude with permission prompts
  // skipped. It must say so, and name both paths, before anything happens.
  it('confirms with what it will do and the paths it will use', async () => {
    state.status = { orchestration: false, suggested_hive: '/home/u/caprock-tasks', suggested_repo: '/home/u/dev/proj' } as Status
    render(<TasksScreen />)
    fireEvent.click(await screen.findByRole('button', { name: /Turn on the task runner/ }))
    expect(await screen.findByText(/with permission prompts skipped/)).toBeTruthy()
    expect(screen.getByDisplayValue('/home/u/caprock-tasks')).toBeTruthy()
    expect(screen.getByDisplayValue('/home/u/dev/proj')).toBeTruthy()
    // Nothing is armed by opening the dialog.
    expect(enabled).toEqual([])
  })

  it('turns the runner on from the button and shows the board', async () => {
    state.status = { orchestration: false, suggested_hive: '/home/u/caprock-tasks', suggested_repo: '/repo' } as Status
    const { container } = render(<TasksScreen />)
    fireEvent.click(await screen.findByRole('button', { name: /Turn on the task runner/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Turn it on' }))
    await waitFor(() => expect(enabled).toEqual([['/home/u/caprock-tasks', '/repo']]))
    // The daemon now reports it on, and the screen must follow without a reload:
    // the board replaces the off state in place.
    await waitFor(() => expect(container.textContent).toContain('+ New task'))
    expect(container.textContent).not.toContain('Turn on the task runner')
  })
})

// A board with six empty columns and two buttons does not say which button
// comes first, and starting the orchestrator over an empty board does nothing.
it('tells a first-time user which button comes first', async () => {
  state.status = { orchestration: true } as Status
  state.tasks = []
  render(<TasksScreen />)
  expect(await screen.findByText(/Start here:/)).toBeTruthy()
})

it('drops the start-here line once there is a task', async () => {
  state.status = { orchestration: true } as Status
  state.tasks = [task()]
  render(<TasksScreen />)
  await screen.findByText('Add /healthz')
  expect(screen.queryByText(/Start here:/)).toBeNull()
})

describe('a task that was worked', () => {
  const detail: TaskDetail = {
    task: task(),
    body: 'Add a GET /healthz.',
    done_criteria: ['go test ./...'],
    work: {
      branch: 'caprock/worker-1',
      worktree: '/repo/.caprock-worktrees/worker-1',
      repo: '/repo',
      sessions: [{ session_id: 'sess-abc', cwd: '/repo/.caprock-worktrees/worker-1', from_ts: 1 }],
      verifications: [{ round: 1, command: 'go test ./...', exit_code: 0, ts: 2 }],
    },
  }

  it('names the branch on the card without being opened', async () => {
    state.status = { orchestration: true } as Status
    state.tasks = [task()]
    render(<TasksScreen />)
    expect(await screen.findByText('caprock/worker-1')).toBeTruthy()
  })

  it('opens to the diff, the checks that passed, and the command that lands it', async () => {
    state.status = { orchestration: true } as Status
    state.tasks = [task()]
    state.detail = detail
    state.diff = {
      root: '/repo/.caprock-worktrees/worker-1',
      branch: 'caprock/worker-1',
      stat: '',
      files: [{ path: 'health.go', status: 'added', additions: 12, deletions: 0 }],
    }
    render(<TasksScreen />)
    fireEvent.click(await screen.findByText('Add /healthz'))

    // What changed.
    expect(await screen.findByText('health.go')).toBeTruthy()
    expect(screen.getByText('+12')).toBeTruthy()
    // What proved it.
    expect(screen.getByText('passed')).toBeTruthy()
    expect(screen.getByText('go test ./...')).toBeTruthy()
    // Where it is, and how to take it.
    expect(screen.getByText('/repo/.caprock-worktrees/worker-1')).toBeTruthy()
    expect(screen.getByText('$ git merge --no-ff caprock/worker-1')).toBeTruthy()
  })

  it('says what will be checked before anything has run', async () => {
    state.status = { orchestration: true } as Status
    state.tasks = [task({ status: 'in_progress' })]
    state.detail = { ...detail, task: task({ status: 'in_progress' }), work: { ...detail.work, verifications: undefined } }
    render(<TasksScreen />)
    fireEvent.click(await screen.findByText('Add /healthz'))
    await waitFor(() => expect(screen.getByText('$ go test ./...')).toBeTruthy())
    expect(screen.getByText(/Caprock runs these itself/)).toBeTruthy()
  })
})

// A task nobody has picked up has nothing to show, so the card must not offer a
// drawer that would open on four empty panels.
it('does not open a task that has no assignee', async () => {
  state.status = { orchestration: true } as Status
  state.tasks = [task({ status: 'inbox', assignee: '' })]
  render(<TasksScreen />)
  const card = await screen.findByTitle(/no worker has picked this up/)
  expect(card.hasAttribute('disabled')).toBe(true)
})
