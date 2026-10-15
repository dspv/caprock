/**
 * The picker exists so nobody has to type an absolute path from memory into a
 * dashboard that is already showing their repositories. What is tested is that
 * each list produces a path, and that the two rules which make it usable hold:
 * repositories lead, and there is no "up" at the root.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BrowseResponse, RecentDir } from '@/lib/api'

const data = vi.hoisted(() => ({
  recent: [] as RecentDir[],
  browse: {} as BrowseResponse,
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      recentDirs: async () => data.recent,
      // The daemon answers with the folder resolved: "~/dev" comes back absolute.
      browse: async (dir = '') => ({ ...data.browse, dir: dir.startsWith('/') ? dir : data.browse.dir }),
    },
  }
})

import { crumbs, DirPicker } from './DirPicker'

const NOW = Date.now()

describe('DirPicker', () => {
  it('picks a path from the directories sessions have already run in', async () => {
    // The repository someone wants next is almost always one they were in
    // yesterday, which is why this list comes first.
    data.recent = [
      { dir: '/Users/x/dev/api', name: 'api', sessions: 3, last_event_at: NOW - 60_000 },
      { dir: '/Users/x/dev/web', name: 'web', sessions: 1, last_event_at: NOW - 86_400_000 },
    ]
    const onPick = vi.fn()
    render(<DirPicker value="" onPick={onPick} />)

    fireEvent.click(await screen.findByText('api'))
    expect(onPick).toHaveBeenCalledWith('/Users/x/dev/api')
  })

  it('opens on Browse when there is no history to show', async () => {
    // A fresh install is the case a picker matters most, and it is exactly the
    // case with an empty Recent list. Opening on an empty tab would be worst.
    data.recent = []
    data.browse = {
      dir: '/Users/x',
      parent: '',
      root: '/Users/x',
      entries: [{ name: 'dev', path: '/Users/x/dev', repo: false }],
    }
    render(<DirPicker value="" onPick={() => {}} />)
    expect(await screen.findByText('dev')).toBeTruthy()
  })

  it('leads with repositories, because a repository is what is being looked for', async () => {
    data.recent = []
    data.browse = {
      dir: '/Users/x/dev',
      parent: '/Users/x',
      root: '/Users/x',
      entries: [
        { name: 'a-repo', path: '/Users/x/dev/a-repo', repo: true },
        { name: 'plain', path: '/Users/x/dev/plain', repo: false },
      ],
    }
    render(<DirPicker value="" onPick={() => {}} />)
    await screen.findByText('a-repo')
    expect(screen.getByText('repo')).toBeTruthy()
  })

  it('disables "up" at the root, rather than offering one that would be refused', async () => {
    data.recent = []
    data.browse = { dir: '/Users/x', parent: '', root: '/Users/x', entries: [] }
    render(<DirPicker value="" onPick={() => {}} />)
    await waitFor(() => expect(screen.getByText(/nothing here/i)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Up to the parent folder' })).toBeDisabled()
  })

  it('offers "up" below the root', async () => {
    data.recent = []
    data.browse = {
      dir: '/Users/x/dev',
      parent: '/Users/x',
      root: '/Users/x',
      entries: [{ name: 'thing', path: '/Users/x/dev/thing', repo: false }],
    }
    render(<DirPicker value="" onPick={() => {}} />)
    await screen.findByText('thing')
    expect(screen.getByRole('button', { name: 'Up to the parent folder' })).toBeEnabled()
  })

  // A folder browser (owner, 2026-10-09): opens on the default folder, a
  // click selects, Enter or a double-click goes in, Choose picks.
  it('opens on the default folder and is driven from the keyboard', async () => {
    data.recent = []
    data.browse = {
      dir: '/Users/x/dev',
      parent: '/Users/x',
      root: '/Users/x',
      entries: [
        { name: 'api', path: '/Users/x/dev/api', repo: true },
        { name: 'web', path: '/Users/x/dev/web', repo: false },
      ],
    }
    const browse = vi.spyOn((await import('@/lib/api')).api, 'browse')
    const onPick = vi.fn()
    render(<DirPicker value="" onPick={onPick} start="~/dev" />)
    await screen.findByText('api')
    expect(browse).toHaveBeenCalledWith('~/dev')
    // Nothing selected: Choose takes the folder shown.
    fireEvent.click(screen.getByRole('button', { name: 'Choose this folder' }))
    expect(onPick).toHaveBeenLastCalledWith('/Users/x/dev')
    const list = screen.getByRole('listbox', { name: 'Folders' })
    // Each step waits for its own render: on a loaded CI runner the second
    // key could land before the first selection had rendered (2026-10-13).
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    await waitFor(() => expect(screen.getByRole('option', { name: /api/ })).toHaveAttribute('aria-selected', 'true'))
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    await waitFor(() => expect(screen.getByRole('option', { name: /web/ })).toHaveAttribute('aria-selected', 'true'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose web' }))
    expect(onPick).toHaveBeenLastCalledWith('/Users/x/dev/web')
    fireEvent.keyDown(list, { key: 'Enter' })
    await waitFor(() => expect(browse).toHaveBeenCalledWith('/Users/x/dev/web'))
    fireEvent.doubleClick(screen.getByRole('option', { name: /api/ }))
    await waitFor(() => expect(browse).toHaveBeenCalledWith('/Users/x/dev/api'))
    browse.mockRestore()
  })

  // A key pressed the moment a folder's entries appear is not lost. The
  // selection used to be cleared by an effect on the folder, which React runs
  // after the commit that draws the entries; on a loaded CI runner the test's
  // ArrowDown landed in between and the late clear undid it (2026-10-14).
  it('keeps a key pressed as soon as the folder is drawn', async () => {
    data.recent = []
    data.browse = {
      dir: '/Users/x/dev',
      parent: '/Users/x',
      root: '/Users/x',
      entries: [{ name: 'api', path: '/Users/x/dev/api', repo: true }],
    }
    const mod = await import('@/lib/api')
    let land: (b: BrowseResponse) => void = () => {}
    const browse = vi.spyOn(mod.api, 'browse').mockImplementation(() => new Promise((r) => { land = r }))
    render(<DirPicker value="" onPick={() => {}} start="~/dev" />)
    await screen.findByRole('listbox', { name: 'Folders' })
    // The answer lands outside act, and the key follows the commit that
    // draws it at once, as a findBy on a loaded runner can: the DOM is there,
    // that commit's passive effects have not run yet.
    const drawn = new Promise<void>((done) => {
      const mo = new MutationObserver(() => {
        if (screen.queryByRole('option', { name: /api/ })) { mo.disconnect(); done() }
      })
      mo.observe(document.body, { childList: true, subtree: true })
    })
    land(data.browse)
    await drawn
    expect(screen.getByRole('option', { name: /api/ })).toHaveAttribute('aria-selected', 'false')
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Folders' }), { key: 'ArrowDown' })
    await waitFor(() => expect(screen.getByRole('option', { name: /api/ })).toHaveAttribute('aria-selected', 'true'))
    browse.mockRestore()
  })
})

describe('crumbs', () => {
  it('walks from the root down, the root called ~', () => {
    expect(crumbs('/Users/x/dev/api', '/Users/x')).toEqual([
      { label: '~', path: '/Users/x' },
      { label: 'dev', path: '/Users/x/dev' },
      { label: 'api', path: '/Users/x/dev/api' },
    ])
    expect(crumbs('/Users/x', '/Users/x')).toEqual([{ label: '~', path: '/Users/x' }])
    expect(crumbs('C:\\Users\\x\\dev', 'C:\\Users\\x')).toEqual([
      { label: '~', path: 'C:\\Users\\x' },
      { label: 'dev', path: 'C:\\Users\\x\\dev' },
    ])
  })
})
