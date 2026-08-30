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
      browse: async (dir = '') => ({ ...data.browse, dir: dir || data.browse.dir }),
    },
  }
})

import { DirPicker } from './DirPicker'

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

  it('offers no "up" at the root, rather than one that would be refused', async () => {
    data.recent = []
    data.browse = { dir: '/Users/x', parent: '', root: '/Users/x', entries: [] }
    render(<DirPicker value="" onPick={() => {}} />)
    await waitFor(() => expect(screen.getByText(/nothing here/i)).toBeInTheDocument())
    expect(screen.queryByText(/up/i)).toBeNull()
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
    expect(await screen.findByText(/up/i)).toBeTruthy()
  })
})
