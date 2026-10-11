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
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TasksScreen } from './Tasks'
import type { CreateTaskRequest, DiffResult, Status, Task, TaskDetail, TaskStarter } from '@/lib/api'

const state = vi.hoisted(() => ({
  status: {} as Partial<Status>,
  tasks: [] as Task[],
  detail: {} as TaskDetail,
  diff: undefined as DiffResult | undefined,
  // Every (hive, repo) pair POST /v1/hive was called with. The off state's whole
  // job is that this stays empty until the user confirms.
  enabled: [] as [string, string][],
  starter: { repo: '/repo', checks: [], default_budget_usd: 5 } as TaskStarter,
  created: [] as CreateTaskRequest[],
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
      taskStarter: async () => state.starter,
      createTask: async (req: CreateTaskRequest) => { state.created.push(req); return {} as TaskDetail },
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
  state.created.length = 0
  state.starter = { repo: '/repo', checks: [], default_budget_usd: 5 }
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

  // The concept arrives as one worked example in four labelled steps, not as
  // paragraphs. A user should be able to take it in without reading prose.
  it('is a worked example in steps, and never says "Phase 2" or "hive"', async () => {
    state.status = { orchestration: false } as Status
    const { container } = render(<TasksScreen />)
    expect(await screen.findByText('You write the task')).toBeTruthy()
    expect(screen.getByText('A worker does it')).toBeTruthy()
    expect(screen.getByText('Caprock checks it')).toBeTruthy()
    expect(screen.getByText('You take it')).toBeTruthy()
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

// An empty board is where a first-time user lands after turning it on: it
// must show what to hand off, not six empty columns.
it('shows the templates and how a task runs on an empty board', async () => {
  state.status = { orchestration: true } as Status
  state.tasks = []
  render(<TasksScreen />)
  expect(await screen.findByRole('region', { name: 'Start from a template' })).toBeTruthy()
  expect(screen.getByRole('list', { name: 'How a task runs' })).toBeTruthy()
  expect(screen.getByText('Fix failing tests')).toBeTruthy()
})

it('folds the gallery to one line once there is a task', async () => {
  state.status = { orchestration: true } as Status
  state.tasks = [task()]
  render(<TasksScreen />)
  await screen.findByText('Add /healthz')
  expect(screen.queryByRole('region', { name: 'Start from a template' })).toBeNull()
  expect(screen.getByText('Start from:')).toBeTruthy()
})

// A task in the queue does nothing until the orchestrator runs; that stall is
// said where the task is, with the button.
it('says a queued task is waiting for the orchestrator', async () => {
  state.status = { orchestration: true, claude_available: true } as Status
  state.tasks = [task({ status: 'inbox', assignee: '' })]
  render(<TasksScreen />)
  expect(await screen.findByText(/1 task is waiting/)).toBeTruthy()
})

describe('templates', () => {
  // The checks come from the repository, never from the template: a Go
  // command prefilled into a JavaScript repo is a task that can never pass.
  it('opens the form prefilled, with the checks the repo declares', async () => {
    state.status = { orchestration: true } as Status
    state.starter = {
      repo: '/repo', default_budget_usd: 5,
      checks: [
        { command: 'make check', kind: 'all', source: 'Makefile' },
        { command: 'make test', kind: 'test', source: 'Makefile' },
        { command: 'go test ./...', kind: 'test', source: 'go.mod' },
      ],
    }
    render(<TasksScreen />)
    const gallery = await screen.findByRole('region', { name: 'Start from a template' })
    await waitFor(() => expect(within(gallery).getAllByText('make test').length).toBeGreaterThan(0))
    fireEvent.click(within(gallery).getByText('Fix failing tests'))
    const dialog = await screen.findByRole('dialog', { name: 'New task' })
    expect((within(dialog).getByPlaceholderText(/healthz/) as HTMLInputElement).value).toBe('Fix the failing tests in <folder>')
    // One command per kind, the project's own first: make test, not both.
    expect((within(dialog).getByRole('textbox', { name: /checks that must pass/i }) as HTMLTextAreaElement).value).toBe('make test')
    // The budget is the user's: empty, with the daemon's ceiling as the hint.
    expect((within(dialog).getByRole('textbox', { name: /budget/i }) as HTMLInputElement).value).toBe('')
    expect(within(dialog).getByText(/Empty means Caprock's ceiling of \$5/)).toBeTruthy()
  })

  it('will not create a task while a template part is unfilled', async () => {
    state.status = { orchestration: true } as Status
    state.starter = { repo: '/repo', default_budget_usd: 5, checks: [{ command: 'npm test', kind: 'test', source: 'package.json' }] }
    render(<TasksScreen />)
    fireEvent.click(await screen.findByText('Add tests for a file'))
    const dialog = await screen.findByRole('dialog', { name: 'New task' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }))
    expect(await within(dialog).findByText(/Fill in <file> first/)).toBeTruthy()
    expect(state.created).toEqual([])
    fireEvent.change(within(dialog).getByPlaceholderText(/healthz/), { target: { value: 'Add tests for src/parse.ts' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /what the agent should do/i }), { target: { value: 'Cover src/parse.ts.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }))
    await waitFor(() => expect(state.created).toHaveLength(1))
    expect(state.created[0]).toMatchObject({ title: 'Add tests for src/parse.ts', done_criteria: ['npm test'], budget_usd: 0 })
  })

  it('leaves the checks empty, and says so, when the repo declares none', async () => {
    state.status = { orchestration: true } as Status
    render(<TasksScreen />)
    expect(await screen.findByText(/No test, lint or build commands found/)).toBeTruthy()
    fireEvent.click(screen.getByText('Fix lint and type errors'))
    const dialog = await screen.findByRole('dialog', { name: 'New task' })
    expect((within(dialog).getByRole('textbox', { name: /checks that must pass/i }) as HTMLTextAreaElement).value).toBe('')
    expect(within(dialog).getByText(/No check commands were found in this repo/)).toBeTruthy()
  })

  // Picking a template with the runner off asks to turn it on first, then
  // opens that template — the pick is not lost to the confirmation.
  it('turns the runner on, then opens the template picked in the off state', async () => {
    state.status = { orchestration: false, suggested_hive: '/h', suggested_repo: '/repo' } as Status
    render(<TasksScreen />)
    fireEvent.click(await screen.findByText('Bump a dependency'))
    fireEvent.click(await screen.findByRole('button', { name: 'Turn it on' }))
    await waitFor(() => expect(enabled).toEqual([['/h', '/repo']]))
    const dialog = await screen.findByRole('dialog', { name: 'New task' })
    expect((within(dialog).getByPlaceholderText(/healthz/) as HTMLInputElement).value).toBe('Upgrade <package> to <version>')
  })
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
    expect((await screen.findAllByText(/caprock\/worker-1/)).length).toBeGreaterThan(0)
  })

  // The row says what the task is doing, how its checks went and what it cost,
  // and offers the one thing to do with a finished task.
  it('reads as state, now, checks, cost and one action', async () => {
    state.status = { orchestration: true } as Status
    state.tasks = [task()]
    render(<TasksScreen />)
    expect(await screen.findByText('Done')).toBeTruthy()
    expect(screen.getByText(/Checks passed\. The work is on branch caprock\/worker-1/)).toBeTruthy()
    expect(screen.getByText('passed')).toBeTruthy()
    expect(screen.getByText('of $3.00')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Review & merge' })).toBeTruthy()
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
    const drawer = await screen.findByRole('dialog', { name: 'Task' })

    // What changed.
    expect(await within(drawer).findByText('health.go')).toBeTruthy()
    expect(within(drawer).getByText('+12')).toBeTruthy()
    // What proved it.
    expect(within(drawer).getByText('passed')).toBeTruthy()
    expect(within(drawer).getByText('go test ./...')).toBeTruthy()
    // Where it is, and how to take it.
    expect(within(drawer).getByText('/repo/.caprock-worktrees/worker-1')).toBeTruthy()
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
