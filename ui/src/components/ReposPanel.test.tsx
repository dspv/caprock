import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RepoActivity, ReposActivity } from '@/lib/api'

const h = vi.hoisted(() => ({ answer: undefined as unknown, asked: 0 }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, reposActivity: async () => { h.asked++; return h.answer } } }
})

import { ReposPanel } from './ReposPanel'
import { PANEL_FOLDS_KEY } from './ui'
import { forgetDeckAnswers } from '@/lib/deckCache'

const now = Date.now()
const days = Array.from({ length: 14 }, (_, i) => new Date(now - (13 - i) * 86_400_000).toISOString().slice(0, 10))
const repo = (p: Partial<RepoActivity>): RepoActivity => ({
  project_id: 1, root: '/w/app', name: 'app', days, commits: [0, 1, 0, 2, 0, 0, 3, 1, 0, 2, 4, 0, 1, 5], added: Array(14).fill(10), deleted: Array(14).fill(2),
  last_commit_at: now - 9 * 60_000, dirty: 3, sessions: 2, checked_ms: now, ...p,
})

afterEach(() => { h.answer = undefined; h.asked = 0; forgetDeckAnswers(); localStorage.clear() })

describe('the Repos section', () => {
  it('shows each repository’s local figures and the GitHub figures already read', async () => {
    h.answer = {
      github_connected: true,
      repos: [
        repo({ github: { repo: 'ada/app', pulls: { open: 2, merged_7d: 9, listed: 50 }, ci: { runs: 47, red: 3, workflow: 'ci', median_ms: 430_000 }, release: { tag: 'v1.2.0', state: 'pass', at: now - 2 * 3_600_000 } } }),
        repo({ project_id: 2, root: '/w/lab', name: 'lab', dirty: 0, sessions: 1, github: undefined }),
        repo({ project_id: 3, root: '/w/web', name: 'web', dirty: 0, sessions: 1, github: { repo: 'ada/web' } }),
      ],
    } satisfies ReposActivity
    render(<ReposPanel />)
    const app = await waitFor(() => {
      const r = document.querySelector('[data-repo-row="app"]')
      if (!r) throw new Error('no row')
      return r
    })
    // Today, the last 7 days, and the lines of the last 7.
    expect(app).toHaveTextContent('3 uncommitted')
    expect(app).toHaveTextContent('last commit 9m ago')
    expect(app).toHaveTextContent('5' + '13')
    expect(app).toHaveTextContent('+70 −14')
    expect(app).toHaveTextContent('2 · 9 merged')
    expect(app).toHaveTextContent('6.4% · 7m 10s')
    expect(app).toHaveTextContent('v1.2.0 2h')
    expect(document.querySelector('[data-repo-row="lab"] [data-repo-github="none"]')).toHaveTextContent('not on GitHub')
    // On GitHub, but nothing read for it yet: dashes, and the tooltip says where it is read.
    const web = document.querySelector('[data-repo-row="web"]')!
    expect(web).toHaveTextContent('–')
    expect(web.querySelector('[title^="Not read yet"]')).toBeTruthy()
  })

  it('shows the local figures alone while GitHub is not connected', async () => {
    h.answer = { github_connected: false, repos: [repo({})] } satisfies ReposActivity
    render(<ReposPanel />)
    const off = await waitFor(() => {
      const c = document.querySelector('[data-repo-row="app"] [data-repo-github="off"]')
      if (!c) throw new Error('no row')
      return c
    })
    expect(off).toHaveTextContent('GitHub not connected')
    expect(document.querySelector('[data-repo-row="app"]')).toHaveTextContent('+70 −14')
  })

  it('asks nothing while folded, and remembers the fold', async () => {
    h.answer = { github_connected: false, repos: [repo({})] } satisfies ReposActivity
    localStorage.setItem(PANEL_FOLDS_KEY, JSON.stringify(['now.repos']))
    render(<ReposPanel />)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.asked).toBe(0)
    expect(document.querySelector('[data-repo-row]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Repos/ }))
    await waitFor(() => expect(document.querySelector('[data-repo-row="app"]')).toBeTruthy())
    expect(h.asked).toBe(1)
    expect(JSON.parse(localStorage.getItem(PANEL_FOLDS_KEY) ?? '[]')).not.toContain('now.repos')
  })

  it('says so when no listed repository has a session running', async () => {
    h.answer = { github_connected: true, repos: [] } satisfies ReposActivity
    render(<ReposPanel />)
    expect(await screen.findByText('No listed repository has a session running.')).toBeInTheDocument()
  })
})
