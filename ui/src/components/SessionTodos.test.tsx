import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionTodos, TodoItem } from '@/lib/api'

const h = vi.hoisted(() => ({ todos: { items: [], updated_at: 0 } as SessionTodos }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, todos: async () => h.todos } }
})

import { TodoBlock, todoCount, todoWindow } from './SessionTodos'

const item = (id: number, status: TodoItem['status'], text = `Task ${id}`, active_form?: string): TodoItem => ({ id: String(id), text, status, active_form })

describe('the Tasks block', () => {
  it('lists the tasks with their state and counts the done ones', async () => {
    h.todos = {
      updated_at: 1,
      items: [
        item(1, 'completed', 'Read the code'),
        item(2, 'in_progress', 'Write the test', 'Writing the test'),
        item(3, 'pending', 'Ship it'),
        item(4, 'cancelled', 'Drop the cache'),
      ],
    }
    render(<TodoBlock sessionId="s1" />)
    const block = await screen.findByRole('region', { name: 'Tasks' })
    expect(within(block).getByText('of 3 done').textContent).toBe('1 of 3 done')
    const rows = within(block).getAllByRole('listitem')
    expect(rows.map((r) => r.dataset.status)).toEqual(['completed', 'in_progress', 'pending', 'cancelled'])
    // The task in hand reads as what the agent is doing.
    expect(within(rows[1]!).getByText('Writing the test')).toBeTruthy()
    expect(within(rows[1]!).getByRole('img', { name: 'in progress' })).toBeTruthy()
    expect(within(rows[0]!).getByRole('img', { name: 'done' })).toBeTruthy()
    expect(within(rows[2]!).getByRole('img', { name: 'to do' })).toBeTruthy()
  })

  it('is not there when the session kept no list', async () => {
    h.todos = { items: [], updated_at: 0 }
    const { container } = render(<TodoBlock sessionId="s2" />)
    await new Promise((r) => setTimeout(r, 0))
    expect(container.innerHTML).toBe('')
  })

  it('folds a long list around the work in hand and unfolds on request', async () => {
    h.todos = { updated_at: 1, items: Array.from({ length: 20 }, (_, i) => item(i + 1, i < 12 ? 'completed' : i === 12 ? 'in_progress' : 'pending')) }
    render(<TodoBlock sessionId="s3" />)
    const block = await screen.findByRole('region', { name: 'Tasks' })
    expect(within(block).getAllByRole('listitem')).toHaveLength(8)
    expect(within(block).getByText('Task 11')).toBeTruthy()
    fireEvent.click(within(block).getByRole('button', { name: 'Show all 20' }))
    expect(within(block).getAllByRole('listitem')).toHaveLength(20)
  })
})

describe('todoCount and todoWindow', () => {
  it('leaves cancelled tasks out of the count', () => {
    expect(todoCount([item(1, 'completed'), item(2, 'cancelled'), item(3, 'pending')])).toEqual({ done: 1, total: 2 })
  })

  it('starts two rows before the first open task and never runs past the end', () => {
    const list = Array.from({ length: 12 }, (_, i) => item(i, i < 11 ? 'completed' : 'pending'))
    expect(todoWindow(list)).toEqual({ start: 4, end: 12 })
    expect(todoWindow(list.slice(0, 5))).toEqual({ start: 0, end: 5 })
    const done = list.map((t) => ({ ...t, status: 'completed' as const }))
    expect(todoWindow(done)).toEqual({ start: 4, end: 12 })
  })
})
