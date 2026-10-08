/**
 * The sidebar's primary actions and the folded groups: New agent and Add
 * project at the top, quiet projects folded at the bottom, and a project
 * hidden by hand moving to Hidden and back, remembered across a reload.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/lib/projects'
import { buildSidebar } from '@/lib/sidebar'
import { FOLDS_KEY, HIDDEN_KEY, Sidebar, type SidebarProps } from './Sidebar'

const day = 24 * 60 * 60 * 1000
const proj = (id: string, lastDaysAgo: number): Project =>
  ({ id, root: `/w/${id}`, name: id, kind: 'folder', last_activity: Date.now() - lastDaysAgo * day })

const model = buildSidebar({
  projects: [proj('alpha', 1), proj('beta', 2), proj('stale', 30)],
  sessions: [],
  permissions: new Set(),
  costs: new Map(),
  openSessions: new Set(),
})

function renderSidebar(extra: Partial<SidebarProps> = {}) {
  const props: SidebarProps = {
    model,
    source: 'api',
    activeProjectId: '',
    dashboardActive: true,
    onSelectProject: vi.fn(),
    onOpenSession: vi.fn(),
    onOpenInbox: vi.fn(),
    onNewAgent: vi.fn(),
    onNewShell: vi.fn(),
    onAddProject: vi.fn(),
    onDashboard: vi.fn(),
    onPalette: vi.fn(),
    ...extra,
  }
  return { ...render(<Sidebar {...props} />), props }
}

const listed = () => [...document.querySelectorAll('[data-project-row]')].map((b) => b.getAttribute('data-project-row'))

beforeEach(() => localStorage.clear())

describe('the sidebar', () => {
  it('leads with New agent and Add project', () => {
    const { props } = renderSidebar({ activeProjectId: 'beta' })
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }))
    expect(props.onNewAgent).toHaveBeenCalledWith('beta')
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    expect(props.onAddProject).toHaveBeenCalled()
  })

  it('folds a project quiet for a week under Quiet, closed until opened, and remembers it open', () => {
    const first = renderSidebar()
    expect(listed()).toEqual(['alpha', 'beta'])
    const fold = screen.getByRole('button', { name: /Quiet · 1/ })
    expect(fold).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(fold)
    expect(listed()).toEqual(['alpha', 'beta', 'stale'])
    expect(JSON.parse(localStorage.getItem(FOLDS_KEY)!)).toEqual(['quiet'])
    first.unmount()
    renderSidebar()
    expect(listed()).toEqual(['alpha', 'beta', 'stale'])
  })

  it('hides a project into Hidden and shows it again from there, across a reload', () => {
    const first = renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Hide beta from the list' }))
    expect(listed()).toEqual(['alpha'])
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual(['beta'])
    first.unmount()

    renderSidebar()
    expect(listed()).toEqual(['alpha'])
    const hidden = screen.getByRole('region', { name: 'Hidden' })
    fireEvent.click(within(hidden).getByRole('button', { name: /Hidden · 1/ }))
    fireEvent.click(within(hidden).getByRole('button', { name: 'Show beta in the list again' }))
    expect(listed()).toEqual(['alpha', 'beta'])
    expect(screen.queryByRole('region', { name: 'Hidden' })).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual([])
  })

  it('keeps the project in front listed even when hidden', () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(['beta']))
    renderSidebar({ activeProjectId: 'beta', dashboardActive: false })
    expect(listed()).toEqual(['alpha', 'beta'])
    expect(screen.getByRole('button', { name: 'Show beta in the list again' })).toBeInTheDocument()
  })

  it('survives unreadable storage', () => {
    localStorage.setItem(HIDDEN_KEY, '{not json')
    localStorage.setItem(FOLDS_KEY, '"quiet"')
    renderSidebar()
    expect(listed()).toEqual(['alpha', 'beta'])
  })
})
