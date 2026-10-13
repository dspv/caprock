import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReposCI, RepoCIRow } from '@/lib/reposci'

const h = vi.hoisted(() => ({ answer: undefined as unknown, asked: 0, usage: [] as string[] }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    reposCI: async () => { h.asked++; return h.answer },
    actionsUsage: async (owner?: string) => {
      h.usage.push(owner ?? '')
      return { account: owner, org: false, year: 2026, month: 10, available: false, reason: 'permission', minutes: 0, gross_usd: 0, discount_usd: 0, net_usd: 0, by_sku: [], at: 0 }
    },
  } }
})

import { CICDPanel } from './CICDPanel'
import { PANEL_FOLDS_KEY } from './ui'
import { forgetDeckAnswers } from '@/lib/deckCache'
import { redPct, statusLine, stuckText } from '@/lib/reposci'
import { spanText } from '@/lib/prstats'

const now = Date.now()
const days = Array.from({ length: 14 }, (_, i) => new Date(now - (13 - i) * 86_400_000).toISOString().slice(0, 10))
const row = (p: Partial<RepoCIRow>): RepoCIRow => ({
  project_id: 1, name: 'app', repo: 'ada/app', live: 2, days, stuck: [], open: 3, merged_7d: 9, top_prs: [], authors: [],
  ci: { runs: 50, red: 4, reruns: 2, listed: 100, per_day: Array.from({ length: 14 }, () => ({ runs: 3, red: 0 })), workflows: [{ name: 'ci', runs: 40, red: 4, median_ms: 430_000, median_runs: 36, daily_median_ms: Array(14).fill(430_000) }] },
  ...p,
})

afterEach(() => { h.answer = undefined; h.asked = 0; h.usage = []; forgetDeckAnswers(); localStorage.clear() })

describe('the CI/CD section', () => {
  it('shows each repository’s CI, stuck runs, release, the costliest pull requests and who opened them', async () => {
    h.answer = {
      github_connected: true,
      status: { indicator: 'minor', description: 'Partially Degraded Service', components: [{ name: 'Actions', status: 'degraded_performance' }, { name: 'API Requests', status: 'operational' }], incidents: [{ name: 'Delayed Actions runs', status: 'investigating', url: 'https://stspg.io/x' }], at: now },
      repos: [row({
        stuck: [{ id: 7, name: 'ci', branch: 'feat/x', status: 'in_progress', since: now - 41 * 60_000, median_ms: 9 * 60_000, url: 'https://github.com/ada/app/actions/runs/7' }],
        release: { tag: 'v1.2.0', published_at: now - 2 * 3_600_000, url: 'https://github.com/ada/app/releases/tag/v1.2.0' },
        top_prs: [{ number: 41, title: 'Kanban board', url: 'https://github.com/ada/app/pull/41', state: 'open', author: 'grace', author_avatar: 'https://avatars.githubusercontent.com/u/2', cost_usd: 18.25, sessions: 3, live: 1 }],
        authors: [{ login: 'grace', avatar: 'https://avatars.githubusercontent.com/u/2', prs: 2, merged: 1, cost_usd: 18.25 }, { login: 'ada', prs: 1, merged: 1, cost_usd: 0 }],
      })],
    } satisfies ReposCI
    render(<CICDPanel />)
    const block = await waitFor(() => {
      const b = document.querySelector('[data-cicd-repo="ada/app"]')
      if (!b) throw new Error('no block')
      return b
    })
    expect(document.querySelector('[data-cicd-status]')).toHaveAttribute('data-cicd-status', 'warn')
    expect(document.querySelector('[data-cicd-status]')).toHaveTextContent('GitHub: Actions degraded')
    expect(document.querySelector('[data-cicd-status]')).toHaveTextContent('Delayed Actions runs')
    expect(block.querySelector('[data-cicd-cell="ci"]')).toHaveTextContent('7m 10s')
    expect(block.querySelector('[data-cicd-cell="red"]')).toHaveTextContent('8%')
    expect(block.querySelector('[data-cicd-cell="stuck"]')).toHaveTextContent('1')
    expect(block.querySelector('[data-cicd-cell="stuck"]')).toHaveTextContent('ci on feat/x running 41m, median 9m')
    expect(block).toHaveTextContent('released v1.2.0')
    expect(block.querySelector('[data-cicd-top]')).toHaveTextContent('#41')
    expect(block.querySelector('[data-cicd-top]')).toHaveTextContent('$18.25')
    expect(block.querySelector('[data-cicd-who]')).toHaveTextContent('grace')
    expect(block.querySelector('[data-cicd-who] img')).toHaveAttribute('src', 'https://avatars.githubusercontent.com/u/2')
    // ada has no avatar: initials stand in, nothing loaded.
    expect(block.querySelectorAll('[data-cicd-who] img')).toHaveLength(1)
    // The Actions bill is asked once per owner; without Plan (read) it says how to grant it.
    await waitFor(() => expect(block.querySelector('[data-cicd-cell="usage"]')).toHaveTextContent('grant Plan (read) to see it'))
    expect(h.usage).toEqual(['ada'])
  })

  it('asks nothing folded, and says how to connect GitHub', async () => {
    localStorage.setItem(PANEL_FOLDS_KEY, JSON.stringify(['now.cicd']))
    h.answer = { github_connected: false, repos: [] }
    render(<CICDPanel />)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.asked).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: /CI\/CD/ }))
    expect(await screen.findByText(/Connect GitHub in Settings/)).toBeInTheDocument()
    expect(h.asked).toBe(1)
    expect(h.usage).toEqual([])
  })

  it('says GitHub’s status, red share and stuck runs in words', () => {
    expect(statusLine({ indicator: 'none', description: 'All Systems Operational', components: [{ name: 'Actions', status: 'operational' }], incidents: [], at: 0 })?.tone).toBe('ok')
    expect(statusLine({ indicator: 'major', description: 'Major Outage', components: [{ name: 'Git Operations', status: 'major_outage' }], incidents: [], at: 0 })?.text).toBe('GitHub: Git Operations down')
    expect(statusLine({ indicator: '', description: '', components: [], incidents: [], at: 0, error: 'could not reach githubstatus.com' })?.tone).toBe('faint')
    expect(redPct({ runs: 47, red: 3, reruns: 0, listed: 100, per_day: [], workflows: [] })).toBe('6.4%')
    expect(redPct({ runs: 0, red: 0, reruns: 0, listed: 0, per_day: [], workflows: [] })).toBeUndefined()
    expect(stuckText({ id: 1, name: 'release', status: 'queued', since: now - 22 * 60_000 }, now, spanText)).toBe('release waiting for a runner 22m')
  })
})
