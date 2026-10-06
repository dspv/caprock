/**
 * GitHub in the interface (WP-19): Settings connects and shows who, what and
 * whether it works; the clone picker lists, searches and fills the address;
 * the Changes view shows a pull request's checks and opens one. Every
 * failure the daemon reports — 401, a missing scope, 404, a rate limit, the
 * network, a pull request that exists — is asserted on screen.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubStatus, PullRequest, WorktreeGitHub } from '@/lib/github'
import { prStore } from '@/lib/github'
import { GitHubSettings } from './GitHubSettings'
import { RepoPicker } from './RepoPicker'
import { GitHubStrip, PRDot, PullRequestCard } from './PullRequest'

interface Call { method: string; url: string; body?: unknown }
let calls: Call[] = []
let handler: (c: Call) => { status?: number; body: unknown }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const NOT_CONNECTED: GitHubStatus = {
  connected: false, scopes: [], scopes_known: false, sources: { gh: true, stored: false, store: 'keychain', oauth: false },
  health: {}, notify: true, tracked: 0,
}

function connected(over: Partial<GitHubStatus> = {}): GitHubStatus {
  return {
    ...NOT_CONNECTED, connected: true, source: 'gh', user: { login: 'ada', name: 'Ada L' }, scopes: ['repo', 'read:org'], scopes_known: true,
    token_kind: 'oauth', health: { last_ok_at: Date.now() - 120_000, rate: { resource: 'core', limit: 5000, remaining: 4812, reset_at: Date.now() + 3_600_000, used: 188 } },
    tracked: 2, ...over,
  }
}

/** A daemon refusal as internal/api/github.go writes it. */
function fail(status: number, kind: string, doing: string, message: string, extra: Record<string, unknown> = {}) {
  return { status, body: { error: `${doing}: ${message}`, kind, doing, message, ...extra } }
}

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    project_id: 7, worktree: 'feat-x', branch: 'feat/x', repo: 'ada/caprock', number: 12, url: 'https://github.com/ada/caprock/pull/12',
    title: 'Add the thing', state: 'open', draft: false, base: 'main', head_sha: 'abc', mergeable: true, mergeable_state: 'clean',
    review: 'approved', reviews: [{ user: 'grace', state: 'approved' }],
    checks: { state: 'fail', passed: 1, failed: 1, pending: 0, items: [{ name: 'lint', state: 'pass' }, { name: 'build', state: 'fail', url: 'https://ci/1' }] },
    at: Date.now(), ...over,
  }
}

function wt(over: Partial<WorktreeGitHub> = {}): WorktreeGitHub {
  return {
    connected: true, repo: { owner: 'ada', name: 'caprock', full_name: 'ada/caprock', html_url: 'https://github.com/ada/caprock' },
    branch: 'feat/x', base: 'main', remote: 'origin', published: false, ahead: 2, pr: null, primed: true,
    draft: { title: 'feat: x', body: '- first\n- second', commits: ['second', 'first'] }, ...over,
  }
}

beforeEach(() => {
  localStorage.clear()
  calls = []
  handler = () => ({ body: NOT_CONNECTED })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const c: Call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body as string) : undefined }
    calls.push(c)
    const r = handler(c)
    return json(r.status ?? 200, r.body)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Settings → GitHub', () => {
  it('connects with the GitHub CLI login and shows the account, scopes and health', async () => {
    handler = (c) => c.url === '/v1/github/connect' ? { body: connected() } : { body: NOT_CONNECTED }
    render(<GitHubSettings />)
    fireEvent.click(await screen.findByText('Use my GitHub CLI login'))
    expect(await screen.findByText('@ada')).toBeTruthy()
    expect(calls.find((c) => c.url === '/v1/github/connect')?.body).toEqual({ source: 'gh' })
    expect(screen.getByText(/through your GitHub CLI login/)).toBeTruthy()
    expect(screen.getByText('repo, read:org')).toBeTruthy()
    expect(screen.getByLabelText('GitHub health').textContent).toMatch(/last worked 2 min ago · 4,812 of 5,000 requests left, resets .* · following 2 pull requests/)
    expect(screen.getByText(/Your GitHub CLI login is not touched/)).toBeTruthy()
  })

  it('shows a 401 for a pasted token, and keeps the field', async () => {
    handler = (c) => c.url === '/v1/github/connect'
      ? fail(502, 'auth', 'Connecting GitHub', 'GitHub rejected the token (401: Bad credentials): it was revoked, expired or mistyped. Paste a new token in Settings → GitHub.')
      : { body: NOT_CONNECTED }
    render(<GitHubSettings />)
    fireEvent.change(await screen.findByLabelText('GitHub token'), { target: { value: 'ghp_bad' } })
    fireEvent.click(screen.getByText('Connect'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connecting GitHub: GitHub rejected the token (401: Bad credentials)')
    expect(calls.find((c) => c.url === '/v1/github/connect')?.body).toEqual({ source: 'token', token: 'ghp_bad' })
  })

  it('says when the GitHub CLI is missing, and offers sign-in only with a client id', async () => {
    handler = () => ({ body: { ...NOT_CONNECTED, sources: { ...NOT_CONNECTED.sources, gh: false } } })
    render(<GitHubSettings />)
    expect(await screen.findByText(/The GitHub CLI \(gh\) is not installed here/)).toBeTruthy()
    expect((screen.getByText('Use my GitHub CLI login') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Sign in with GitHub')).toBeNull()
  })

  it('runs the device flow: shows the code, then the account', async () => {
    let polls = 0
    handler = (c) => {
      if (c.url === '/v1/github/device' && c.method === 'POST') return { body: { device: { state: 'pending', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_at: Date.now() + 900_000, interval: 5 } } }
      if (c.url === '/v1/github/device') { polls++; return { body: { device: { state: polls > 1 ? 'done' : 'pending', user_code: 'ABCD-1234' } } } }
      if (c.url === '/v1/github') return { body: polls > 1 ? connected({ source: 'oauth' }) : { ...NOT_CONNECTED, sources: { ...NOT_CONNECTED.sources, oauth: true, client: 'Iv1.x' } } }
      return { body: NOT_CONNECTED }
    }
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<GitHubSettings />)
    fireEvent.click(await screen.findByText('Sign in with GitHub'))
    expect(await screen.findByLabelText('Your code')).toHaveTextContent('ABCD-1234')
    for (let i = 0; i < 3 && polls < 2; i++) await act(async () => { vi.advanceTimersByTime(2100) })
    expect(await screen.findByText('@ada', {}, { timeout: 3000 })).toBeTruthy()
    expect(screen.getByText(/through Sign in with GitHub/)).toBeTruthy()
  })

  it('shows the last error on the health line, a missing repo scope, and a rate-limit pause', async () => {
    handler = () => ({ body: connected({ scopes: ['read:org'], health: { last_ok_at: Date.now() - 60_000, paused_until: Date.now() + 120_000, error: { kind: 'scope', doing: 'Opening the pull request', message: 'The token lacks `repo` (403).', at: Date.now() } } }) })
    render(<GitHubSettings />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Opening the pull request: The token lacks `repo` (403).')
    expect(screen.getByText(/without/)).toHaveTextContent('private repositories and pull requests are refused')
    expect(screen.getByLabelText('GitHub health')).toHaveTextContent("paused by GitHub's rate limit until")
    expect(screen.getByText('last call failed')).toBeTruthy()
  })

  it('says when the token is in a file because the Keychain refused it', async () => {
    const note = 'No login keychain at /Users/ada/Library/Keychains/login.keychain-db, so the token is in a file in the data directory, readable by you only.'
    handler = () => ({ body: connected({ source: 'token', sources: { ...NOT_CONNECTED.sources, stored: true, store: 'file', store_note: note } }) })
    render(<GitHubSettings />)
    expect(await screen.findByText(note)).toBeTruthy()
    expect(screen.getByText(/Removes the token from the data directory/)).toBeTruthy()
  })

  it('disconnects', async () => {
    handler = (c) => c.method === 'DELETE' ? { body: NOT_CONNECTED } : { body: connected({ source: 'token' }) }
    render(<GitHubSettings />)
    expect(await screen.findByText(/Removes the token from the Keychain/)).toBeTruthy()
    fireEvent.click(screen.getByText('Disconnect'))
    expect(await screen.findByText('Use my GitHub CLI login')).toBeTruthy()
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/v1/github')).toBe(true)
  })
})

describe('the clone picker', () => {
  const repos = [
    { full_name: 'ada/caprock', name: 'caprock', owner: 'ada', private: true, fork: false, archived: false, clone_url: 'https://github.com/ada/caprock.git', ssh_url: 'git@github.com:ada/caprock.git', html_url: '' },
    { full_name: 'acme/site', name: 'site', owner: 'acme', private: false, fork: false, archived: false, description: 'the site', clone_url: 'https://github.com/acme/site.git', ssh_url: 'git@github.com:acme/site.git', html_url: '' },
  ]

  it('lists, pages, searches and fills the address', async () => {
    handler = (c) => {
      if (c.url === '/v1/github') return { body: connected() }
      if (c.url === '/v1/github/owners') return { body: { owners: [{ login: 'ada', org: false }, { login: 'acme', org: true }] } }
      if (c.url.startsWith('/v1/github/repos')) {
        const u = new URL(c.url, 'http://x')
        if (u.searchParams.get('q')) return { body: { repos: [repos[1]], page: 1, next: false, search: true } }
        return { body: { repos: u.searchParams.get('page') === '2' ? [repos[1]] : [repos[0]], page: Number(u.searchParams.get('page')), next: u.searchParams.get('page') === '1' } }
      }
      return { body: {} }
    }
    const picked: string[] = []
    render(<RepoPicker onPick={(u) => picked.push(u)} />)
    expect(await screen.findByText('caprock')).toBeTruthy()
    expect(screen.getByText('private')).toBeTruthy()
    fireEvent.click(screen.getByText('More…'))
    expect(await screen.findByText('the site')).toBeTruthy()
    fireEvent.click(screen.getByText('caprock'))
    expect(picked).toEqual(['https://github.com/ada/caprock.git'])
    fireEvent.click(screen.getByLabelText('SSH'))
    fireEvent.click(screen.getByText('caprock'))
    expect(picked[1]).toBe('git@github.com:ada/caprock.git')
    fireEvent.change(screen.getByLabelText('Search your repositories'), { target: { value: 'sit' } })
    await waitFor(() => expect(calls.some((c) => c.url.includes('q=sit'))).toBe(true))
    await waitFor(() => expect(screen.queryByText('caprock')).toBeNull())
  })

  it('shows a rate limit, a 404 and the network failing as they come', async () => {
    let next = fail(429, 'rate_limit', 'Listing your repositories', "GitHub's rate limit was reached (403); Caprock waits 1m30s, until 14:05:00, before asking again.")
    handler = (c) => c.url === '/v1/github' ? { body: connected() } : c.url.startsWith('/v1/github/repos') ? next : { body: { owners: [] } }
    const { unmount } = render(<RepoPicker onPick={() => {}} />)
    expect(await screen.findByRole('alert')).toHaveTextContent("Listing your repositories: GitHub's rate limit was reached")
    unmount()
    next = fail(502, 'not_found', "Listing acme's repositories", 'GitHub has no such thing, or this token cannot see it (404).')
    const r2 = render(<RepoPicker onPick={() => {}} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot see it (404)')
    r2.unmount()
    next = fail(502, 'network', 'Listing your repositories', 'could not reach GitHub (api.github.com): dial tcp: no route to host.')
    render(<RepoPicker onPick={() => {}} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not reach GitHub (api.github.com)')
  })

  it('says how to connect when not connected', async () => {
    render(<RepoPicker onPick={() => {}} />)
    expect(await screen.findByText(/Connect GitHub in Settings → GitHub/)).toBeTruthy()
    expect(calls.some((c) => c.url.startsWith('/v1/github/repos'))).toBe(false)
  })
})

describe('a worktree’s pull request', () => {
  const target = { projectId: '7', worktree: 'feat-x' }

  it('opens one, pushing first, and links it', async () => {
    let made = false
    handler = (c) => {
      if (c.url.endsWith('/github/pr?worktree=feat-x')) { made = true; return { body: { pr: pr({ checks: { state: 'none', passed: 0, failed: 0, pending: 0, items: [] } }), pushed: true } } }
      if (c.url.includes('/github?worktree=feat-x')) return { body: made ? wt({ pr: pr(), draft: undefined }) : wt() }
      return { body: { prs: [] } }
    }
    render(<GitHubStrip target={target} title="caprock · feat/x" />)
    fireEvent.click(await screen.findByText('Open pull request…'))
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('feat: x')
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('- first\n- second')
    expect(screen.getByText(/feat\/x is not on GitHub yet: it is pushed first/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Draft'))
    fireEvent.click(screen.getByText('Open draft pull request'))
    expect(await screen.findByText(/Pushed feat\/x and opened #12/)).toBeTruthy()
    expect(calls.find((c) => c.url.endsWith('/github/pr?worktree=feat-x'))?.body).toEqual({ title: 'feat: x', body: '- first\n- second', base: 'main', draft: true })
    expect(screen.getByTitle('Open on GitHub').getAttribute('href')).toBe('https://github.com/ada/caprock/pull/12')
  })

  it('shows 422 already-open with a link, a missing scope, and a failed push', async () => {
    let answer: { status: number; body: Record<string, unknown> } = fail(409, 'exists', 'Opening the pull request', 'a pull request from feat/x is already open: #7 Old', { pr: pr({ number: 7 }) })
    handler = (c) => c.url.endsWith('/github/pr?worktree=feat-x') ? answer : { body: wt() }
    render(<GitHubStrip target={target} title="caprock · feat/x" />)
    fireEvent.click(await screen.findByText('Open pull request…'))
    fireEvent.click(screen.getByText('Open pull request'))
    expect(await screen.findByRole('alert')).toHaveTextContent('already open: #7')
    expect(screen.getByText('Open #7 on GitHub')).toBeTruthy()
    answer = fail(502, 'scope', 'Opening the pull request', 'The token lacks `repo` (403). Run `gh auth refresh -s repo` in a terminal, then try again.', { needs: ['repo'] })
    fireEvent.click(screen.getByText('Open pull request'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('gh auth refresh -s repo'))
    answer = { status: 422, body: { error: 'pushing feat/x first failed: the remote refused your credentials', kind: 'auth', output: 'fatal: Authentication failed' } }
    fireEvent.click(screen.getByText('Open pull request'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('pushing feat/x first failed'))
  })

  it('shows checks, the failing one by name, reviews and mergeability', async () => {
    handler = () => ({ body: wt({ pr: pr(), draft: undefined }) })
    render(<GitHubStrip target={target} title="caprock · feat/x" />)
    expect(await screen.findByText('build failed')).toBeTruthy()
    expect(screen.getByText('approved by @grace')).toBeTruthy()
    expect(screen.getByText('ready to merge')).toBeTruthy()
    expect(screen.getByText('build').getAttribute('href')).toBe('https://ci/1')
  })

  it('says when GitHub is not connected, and offers to publish a project with no remote', async () => {
    handler = () => ({ body: wt({ connected: false }) })
    const r = render(<GitHubStrip target={target} title="caprock · feat/x" />)
    expect(await screen.findByText(/Connect GitHub in Settings to open a pull request/)).toBeTruthy()
    r.unmount()
    handler = (c) => c.url.includes('/github/owners') ? { body: { owners: [{ login: 'ada', org: false }] } } : { body: wt({ reason: 'no_remote', repo: null }) }
    render(<GitHubStrip target={{ projectId: '7', worktree: '' }} title="my-app · main" />)
    fireEvent.click(await screen.findByText('Create a GitHub repository…'))
    expect((screen.getByLabelText('Repository name') as HTMLInputElement).value).toBe('my-app')
  })

  it('on the phone: a viewer reads, a controller opens one', async () => {
    handler = () => ({ body: wt() })
    const r = render(<PullRequestCard target={target} canControl={false} />)
    expect(await screen.findByText('No pull request from feat/x yet.')).toBeTruthy()
    r.unmount()
    render(<PullRequestCard target={target} canControl />)
    fireEvent.click(await screen.findByText('Open a pull request'))
    expect(screen.getByLabelText('Open a pull request')).toBeTruthy()
  })

  it('the sidebar dot follows the live frames', async () => {
    handler = () => ({ body: { prs: [] } })
    render(<PRDot projectId="7" worktree="feat-x" />)
    expect(document.querySelector('[data-pr]')).toBeNull()
    act(() => prStore.apply({ kind: 'pr', pr: pr() }))
    expect(screen.getByRole('img', { name: 'pull request #12: needs attention' })).toBeTruthy()
    act(() => prStore.apply({ kind: 'pr', pr: pr({ checks: { state: 'pass', passed: 2, failed: 0, pending: 0, items: [] } }) }))
    expect(screen.getByRole('img', { name: 'pull request #12: checks passed' })).toBeTruthy()
    act(() => prStore.apply({ kind: 'pr_gone', project_id: 7, worktree: 'feat-x' }))
    expect(document.querySelector('[data-pr]')).toBeNull()
  })
})
