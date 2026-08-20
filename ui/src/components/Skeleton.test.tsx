/**
 * Screens used to test `list.length === 0` without asking whether the fetch had
 * finished, so the first paint announced "No history yet" and then replaced it
 * with real numbers — telling a new user the product has nothing for them at
 * the exact moment it is fetching everything.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Skeleton } from './ui'
import { ProjectsPanel } from './Projects'
import type { ProjectShare } from '@/lib/api'

const projects = vi.hoisted(() => ({ value: undefined as ProjectShare[] | undefined, delay: false }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      summary: async () => {
        if (projects.delay) await new Promise(() => {}) // never resolves
        return { projects: projects.value ?? [] }
      },
    },
  }
})

describe('Skeleton', () => {
  it('renders the requested number of placeholder rows', () => {
    const { container } = render(<Skeleton rows={4} />)
    expect(container.querySelectorAll('.skeleton-pulse')).toHaveLength(4)
  })

  it('is hidden from assistive technology — it carries no information', () => {
    const { container } = render(<Skeleton />)
    expect(container.querySelector('[aria-hidden]')).toBeTruthy()
  })
})

describe('a panel that has not loaded', () => {
  it('shows placeholders rather than claiming there is no data', async () => {
    projects.delay = true
    const { container } = render(<ProjectsPanel sessions={[]} />)
    expect(container.querySelectorAll('.skeleton-pulse').length).toBeGreaterThan(0)
    expect(screen.queryByText(/No spend captured/)).toBeNull()
    projects.delay = false
  })

  it('says so honestly once the answer really is empty', async () => {
    projects.value = []
    render(<ProjectsPanel sessions={[]} />)
    expect(await screen.findByText(/No spend captured/)).toBeTruthy()
  })
})
