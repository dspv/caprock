/**
 * Fix CI and Re-run from the phone (owner, 2026-11-28, translated: "on the
 * phone there is simply no button to send a red CI to be fixed"): the row
 * offers both on a failed PR, asks once inline, and then queues the failed
 * job with its log to the agent Caprock started, starts a new agent when
 * there is none, or asks GitHub to re-run; a phone that may only watch sees
 * them off with the reason. The phone home's Releases draws it under the
 * line that says the PR failed; the session sheet under each failing PR.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type CIRun, type SessionCI, type SessionPRLive, type SessionSummary, type WorkRepo } from '@/lib/api'
import type { PullRequest } from '@/lib/github'
import type { PlanRow, ReleasePlanData } from '@/lib/releaseplan'
import { forgetPRProgress } from '@/lib/usePRForce'
import { PhonePRFix, PhoneSessionPRs, phoneCIKinds } from './PhonePRFix'
import { releaseFixTarget } from './PhoneReleases'
import { ReleasePlan } from './ReleasePlan'

const control = vi.hoisted(() => ({ can: true }))
vi.mock('@/lib/useCanControl', () => ({ useCanControl: () => control.can }))

const now = Date.now()
const live = (n: number, state: PullRequest['checks']['state']): PullRequest => ({
  project_id: 1, worktree: '', branch: `feat/${n}`, repo: 'acme/app', number: n, url: `https://github.com/acme/app/pull/${n}`, title: `PR ${n}`,
  state: 'open', draft: false, base: 'master', head_sha: `sha${n}`, mergeable: true, review: '', reviews: [],
  checks: { state, passed: 1, failed: state === 'fail' ? 1 : 0, pending: 0, items: [{ name: 'go (ubuntu-latest)', state: state === 'pass' ? 'pass' : 'fail' } as PullRequest['checks']['items'][number]] },
  at: now,
})
const runs: CIRun[] = [{ id: 7, name: 'CI', status: 'completed', conclusion: 'failure', jobs: [
  { id: 70, run_id: 7, name: 'go (ubuntu-latest)', status: 'completed', conclusion: 'failure', lines: [], error_line: -1, steps: [] } as unknown as CIRun['jobs'][number],
] }]
const ciOf = (n: number, state: PullRequest['checks']['state'] = 'fail'): SessionCI => ({ connected: true, pr: { number: n, url: `https://github.com/acme/app/pull/${n}`, repo: 'acme/app', live: live(n, state) },
  ci: { repo: 'acme/app', head_sha: `sha${n}`, state: 'fail', runs, runner_ms: 0, by_os: [], at: now } })
const session = (over: Partial<SessionSummary> = {}) => ({ session_id: 's1', name: 'fixer', owned: true, status: 'active', repo_root: '/home/me/app', cwd: '/home/me/app', ...over }) as SessionSummary

beforeEach(() => {
  vi.restoreAllMocks()
  forgetPRProgress()
  control.can = true
})

describe('PhonePRFix', () => {
  it('offers Fix CI and Re-run on a failed PR, Re-run alone on a job given no machine, nothing on a green one', () => {
    expect(phoneCIKinds({ session_id: 's', number: 1, url: '', last_at: 0, live: live(1, 'fail') })).toEqual(['ci', 'rerun'])
    expect(phoneCIKinds({ session_id: 's', number: 1, url: '', last_at: 0, live: live(1, 'no_runner') })).toEqual(['rerun'])
    expect(phoneCIKinds({ session_id: 's', number: 1, url: '', last_at: 0, live: live(1, 'pass') })).toEqual([])
  })

  it('Fix CI asks once inline, then queues the failed job with its log to the session', async () => {
    vi.spyOn(api, 'sessionCI').mockResolvedValue(ciOf(1042))
    const log = vi.spyOn(api, 'sessionCILog').mockResolvedValue({ lines: ['--- FAIL: TestDeliver'] } as never)
    const send = vi.spyOn(api, 'queueSend').mockResolvedValue({ sent: true } as never)
    render(<PhonePRFix sessionId="s1" s={session()} why="" number={1042} />)
    const fix = await screen.findByRole('button', { name: 'Fix CI' })
    expect(screen.getByRole('button', { name: 'Re-run' })).toBeTruthy()
    // 44px targets.
    expect(fix.className).toContain('min-h-11')
    fireEvent.click(fix)
    expect(screen.getByText('Ask to fix #1042 CI?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm' }).className).toContain('min-h-11')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(log).toHaveBeenCalledWith('s1', 70, 'pr', 1042)
    expect(send.mock.calls[0]![0]).toBe('s1')
    expect(send.mock.calls[0]![1]).toContain('--- FAIL: TestDeliver')
    expect(await screen.findByText('agent fixing…')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Sent to fixer')
  })

  it('Cancel puts the buttons back and sends nothing', async () => {
    vi.spyOn(api, 'sessionCI').mockResolvedValue(ciOf(1042))
    const send = vi.spyOn(api, 'queueSend')
    render(<PhonePRFix sessionId="s1" s={session()} why="" number={1042} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fix CI' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Fix CI' })).toBeTruthy()
    expect(send).not.toHaveBeenCalled()
  })

  it('with no agent to type into, starts a new one in a worktree at the PR head', async () => {
    vi.spyOn(api, 'sessionCI').mockResolvedValue(ciOf(1042))
    vi.spyOn(api, 'sessionCILog').mockResolvedValue({ lines: [] } as never)
    const spawn = vi.spyOn(api, 'spawn').mockResolvedValue({ session_id: 'new', cwd: '/home/me/app' })
    render(<PhonePRFix sessionId="s1" s={session({ owned: false })} why="Caprock did not start this session, so it never types into it." number={1042} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fix CI' }))
    expect(screen.getByText('New agent to fix #1042 CI?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    expect(spawn.mock.calls[0]![0]).toMatchObject({ cwd: '/home/me/app', worktree: 'pr-1042-fix', worktree_pr: 1042 })
  })

  it('Re-run asks once, then asks GitHub for the failed jobs', async () => {
    vi.spyOn(api, 'sessionCI').mockResolvedValue(ciOf(1042))
    const rerun = vi.spyOn(api, 'sessionPRRerun').mockResolvedValue({ ok: true, mode: 'failed', runs: 1, jobs: 2 })
    render(<PhonePRFix sessionId="s1" s={session()} why="" number={1042} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Re-run' }))
    expect(screen.getByText('Re-run #1042 on GitHub?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(rerun).toHaveBeenCalledWith('s1', 1042))
    expect(await screen.findByText('re-running 2 jobs…')).toBeTruthy()
  })

  it('a phone that may only watch sees both off, with the reason in words', async () => {
    control.can = false
    vi.spyOn(api, 'sessionCI').mockResolvedValue(ciOf(1042))
    render(<PhonePRFix sessionId="s1" s={session()} why="" number={1042} />)
    expect((await screen.findByRole('button', { name: 'Fix CI' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Re-run' }) as HTMLButtonElement).disabled).toBe(true)
    expect(document.querySelector('[data-phone-pr-fix-why]')?.textContent).toMatch(/can only watch/)
  })

  it('draws nothing on a PR whose checks passed', async () => {
    const read = vi.spyOn(api, 'sessionCI').mockResolvedValue(ciOf(1044, 'pass'))
    const { container } = render(<PhonePRFix sessionId="s1" s={session()} why="" number={1044} />)
    await waitFor(() => expect(read).toHaveBeenCalled())
    expect(container.querySelector('[data-phone-pr-fix]')).toBeNull()
  })
})

describe('PhoneSessionPRs', () => {
  it('lists only the failing pull requests of the session, each with Fix CI', async () => {
    const pr = (n: number, state: PullRequest['checks']['state']): SessionPRLive => ({ session_id: 's1', number: n, url: `https://github.com/acme/app/pull/${n}`, last_at: now, live: live(n, state) })
    vi.spyOn(api, 'sessionPRs').mockResolvedValue({ connected: true, prs: [pr(1042, 'fail'), pr(1044, 'pass')] })
    vi.spyOn(api, 'sessionCI').mockImplementation(async (_id, n) => ciOf(n!, n === 1042 ? 'fail' : 'pass'))
    render(<PhoneSessionPRs sessionId="s1" s={session()} />)
    expect(await screen.findByText('CI failed')).toBeTruthy()
    expect(document.querySelector('[data-phone-session-pr="1042"] [data-phone-pr-fix-action="ci"]')).toBeTruthy()
    expect(document.querySelector('[data-phone-session-pr="1044"]')).toBeNull()
  })
})

describe('Releases: Fix CI under the line that says the PR failed', () => {
  const row = (n: number, red: boolean): PlanRow => ({ key: `pr${n}`, number: n, title: `PR ${n}`, url: `https://github.com/acme/app/pull/${n}`, stage: 'ci', section: 'pr',
    filled: 2, red, warn: false, word: red ? 'CI failed' : 'in CI', running: !red, cost: { text: '—', title: '', known: false }, state: 'ci' } as unknown as PlanRow)
  const plan: ReleasePlanData = { root: '/home/me/app', name: 'app', rows: [row(1117, true), row(1118, true), row(1119, false)], later: [],
    line: [{ key: 'head', text: 'Next release', title: '' }, { key: 'pr', text: 'PR #1118 CI failed +2 more', title: '', tone: 'danger', target: 'pr' }] }

  it('draws it under the line for the PR it tells, under every other failing row, and never twice', () => {
    render(<ReleasePlan plan={plan} phone ciFix={(r) => <span data-fix={r.number}>fix {r.number}</span>} />)
    // The line tells the failing one furthest on, else the newest: #1118 (lib/releaseplan linePR).
    expect(document.querySelector('[data-release-line-fix="1118"] [data-fix="1118"]')).toBeTruthy()
    expect(document.querySelectorAll('[data-fix="1118"]')).toHaveLength(1)
    expect(document.querySelector('[data-release-row-fix="1117"] [data-fix="1117"]')).toBeTruthy()
    expect(document.querySelector('[data-fix="1119"]')).toBeNull()
  })

  it('a fix goes to the agent Caprock started on the branch, else to a new agent in the repository', () => {
    const repo = { root: '/home/me/app', name: 'app', via_session: 'via', live: 1 } as WorkRepo
    const on = releaseFixTarget({ ...row(1117, true), session: { id: 'ag', owned: true, name: 'fixer' } }, repo, true)
    expect(on.s.session_id).toBe('ag')
    expect(on.why).toBe('')
    const none = releaseFixTarget(row(1117, true), repo, true)
    expect(none.s.session_id).toBe('via')
    expect(none.s.repo_root).toBe('/home/me/app')
    expect(none.why).not.toBe('')
  })
})
