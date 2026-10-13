/**
 * Renaming a session from its tab or its sidebar row (owner, 2026-10-13: "in
 * a few clicks, and the new name must show at once in the top tab",
 * translated): double-click or Rename… makes the name a field, Enter or
 * leaving it saves, Escape keeps the old one, and the new name is in the tab
 * and the row before the daemon answers.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/lib/projects'
import type { SessionSummary } from '@/lib/api'

const rename = vi.fn(async (id: string, name: string) => ({ session_id: id, name }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, renameSession: (id: string, name: string) => rename(id, name) } }
})
vi.mock('./TerminalPane', () => ({ TerminalPane: () => null }))

import { buildSidebar } from '@/lib/sidebar'
import { tabLabels } from '@/lib/tablabels'
import type { Tab } from '@/lib/tabs'
import { onSessionRenamed } from '@/lib/sessionNames'
import { applySessionFrames } from '@/lib/useWorkspaceData'
import { Sidebar } from './Sidebar'
import { TabStrip } from './TerminalTabs'

Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })

const proj: Project = { id: 'alpha', root: '/w/alpha', name: 'alpha', kind: 'folder', last_activity: Date.now(), pinned: true }
const sess = (p: Partial<SessionSummary>) => ({
  session_id: 's', cwd: '/w/alpha', project: 'alpha', model: '', started_at: 1, last_event_at: 1, status: 'active',
  git_branch: '', owned: true, activity: { phrase: '', at: '', health: 'working' }, ...p,
}) as SessionSummary
const pane = (id: string, kind: 'session' | 'shell', sessionId: string) => ({ type: 'pane' as const, id, target: { kind, sessionId } })
const agentTab: Tab = { id: 't1', projectId: 'alpha', root: pane('p1', 'session', 'a1'), focusedPaneId: 'p1', title: 'Fix the login' }
const shellTab: Tab = { id: 't2', projectId: 'alpha', root: pane('p2', 'shell', 'sh1'), focusedPaneId: 'p2', title: 'shell' }

/** The tab strip and the sidebar over one held list, patched on a rename as the workspace's is. */
function Workspace({ initial, tabs }: { initial: SessionSummary[]; tabs: Tab[] }) {
  const [sessions, setSessions] = useState(initial)
  useEffect(() => onSessionRenamed((id, name) => setSessions((cur) => applySessionFrames(cur, [[id, { session: { name } }]]))), [])
  const byId = new Map(sessions.map((s) => [s.session_id, s]))
  const labels = tabLabels(tabs, byId, new Set(), () => undefined)
  const model = buildSidebar({ projects: [proj], sessions, permissions: new Set(), costs: new Map(), openSessions: new Set(tabs.map((t) => (t.root.type === 'pane' ? t.root.target.sessionId : ''))) })
  return (
    <>
      <TabStrip
        tabs={tabs} labels={labels} activeTabId={tabs[0]?.id} sessions={byId} permissions={new Set()}
        inspectorOpen={false} sidebarOpen onActivate={() => {}} onDetach={() => {}} onMove={() => {}}
        onNewAgent={() => {}} onNewShell={() => {}} onToggleInspector={() => {}}
      />
      <Sidebar
        model={model} source="api" activeProjectId="alpha" dashboardActive={false} tabs={tabs} tabLabels={labels}
        activeTabId={tabs[0]?.id} onActivateTab={vi.fn()} onCloseTab={vi.fn()} onCloseProjectTabs={vi.fn()} onOpenLive={vi.fn()}
        onSelectProject={vi.fn()} onOpenInbox={vi.fn()} onNewAgent={vi.fn()} onNewShell={vi.fn()} onAddProject={vi.fn()}
        onDashboard={vi.fn()} onPalette={vi.fn()}
      />
    </>
  )
}

const tabEl = () => screen.getAllByRole('tab').find((t) => t.textContent?.includes('Fix the login') || t.querySelector('input'))!
const field = () => screen.getByRole('textbox', { name: 'Session name' }) as HTMLInputElement
const rowTitle = (id: string) => document.querySelector(`[data-tab-row="${id}"] [data-row-title]`)?.textContent

beforeEach(() => {
  rename.mockClear()
  localStorage.clear()
  sessionStorage.clear()
})

describe('renaming a session', () => {
  it('from its tab: a double-click opens the name, Enter saves it, and the tab and the sidebar row show it at once', async () => {
    render(<Workspace initial={[sess({ session_id: 'a1', title: 'Fix the login' })]} tabs={[agentTab]} />)
    fireEvent.doubleClick(tabEl())
    expect(field().value).toBe('Fix the login')
    fireEvent.change(field(), { target: { value: '  Auth   rewrite ' } })
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }) })
    expect(rename).toHaveBeenCalledWith('a1', 'Auth rewrite')
    expect(screen.queryByRole('textbox', { name: 'Session name' })).toBeNull()
    expect(within(screen.getAllByRole('tab')[0]!).getByText('Auth rewrite')).toBeTruthy()
    expect(rowTitle('t1')).toBe('Auth rewrite')
  })

  it('Escape keeps the old name and sends nothing', () => {
    render(<Workspace initial={[sess({ session_id: 'a1', title: 'Fix the login' })]} tabs={[agentTab]} />)
    fireEvent.doubleClick(tabEl())
    fireEvent.change(field(), { target: { value: 'Something else' } })
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(rename).not.toHaveBeenCalled()
    expect(rowTitle('t1')).toBe('Fix the login')
  })

  it('from its sidebar row: Rename… in the menu, and leaving the field saves', async () => {
    render(<Workspace initial={[sess({ session_id: 'a1', title: 'Fix the login' })]} tabs={[agentTab]} />)
    fireEvent.contextMenu(document.querySelector('[data-tab-row="t1"]')!, { clientX: 5, clientY: 5 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }))
    fireEvent.change(field(), { target: { value: 'Login, take two' } })
    await act(async () => { fireEvent.blur(field()) })
    expect(rename).toHaveBeenCalledWith('a1', 'Login, take two')
    expect(rowTitle('t1')).toBe('Login, take two')
    expect(within(screen.getAllByRole('tab')[0]!).getByText('Login, take two')).toBeTruthy()
  })

  it('a double-click on a sidebar row with no tab names it too', async () => {
    render(<Workspace initial={[sess({ session_id: 'a2', title: 'Write the docs' })]} tabs={[]} />)
    fireEvent.doubleClick(document.querySelector('[data-live-row="a2"]')!)
    fireEvent.change(field(), { target: { value: 'Docs pass' } })
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }) })
    expect(rename).toHaveBeenCalledWith('a2', 'Docs pass')
    expect(document.querySelector('[data-live-row="a2"] [data-row-title]')?.textContent).toBe('Docs pass')
  })

  it('a shell is not renamed: it is numbered', () => {
    render(<Workspace initial={[sess({ session_id: 'sh1', kind: 'shell' })]} tabs={[shellTab]} />)
    fireEvent.doubleClick(screen.getAllByRole('tab')[0]!)
    expect(screen.queryByRole('textbox', { name: 'Session name' })).toBeNull()
  })

  it('a rename the daemon refuses is rolled back', async () => {
    rename.mockRejectedValueOnce(new Error('404'))
    render(<Workspace initial={[sess({ session_id: 'a1', title: 'Fix the login', name: 'Mine' })]} tabs={[agentTab]} />)
    expect(rowTitle('t1')).toBe('Mine')
    fireEvent.doubleClick(screen.getAllByRole('tab')[0]!)
    expect(field().value).toBe('Mine')
    fireEvent.change(field(), { target: { value: 'Lost' } })
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }) })
    expect(rowTitle('t1')).toBe('Mine')
  })
})
