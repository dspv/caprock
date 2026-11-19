import { describe, expect, it } from 'vitest'
import type { CIJob, CIRun, RepoStats, SessionPRLive } from './api'
import type { BranchPR } from './branches'
import { foreignRepo, prRepoOf, repoShort } from './ci'
import { firstPick, jobFamily, jobGrid, pctText, spanText, statsWords, tabRows, vsMedianText } from './prstats'

const job = (id: number, name: string, os: string, conclusion = 'success', status = 'completed'): CIJob =>
  ({ id, run_id: 1, name, status, conclusion, labels: [], os, steps: [] }) as CIJob

describe('the Pipeline page', () => {
  it('lays the jobs out by name and runner OS, the OS taken out of a matrix name', () => {
    expect(jobFamily('go (windows-latest)')).toBe('go')
    expect(jobFamily('pty spike (ubuntu-latest)')).toBe('pty spike')
    expect(jobFamily('test (macos-14)')).toBe('test')
    expect(jobFamily('ui (typecheck, test, build)')).toBe('ui (typecheck, test, build)')
    const runs = [{ id: 1, name: 'ci', status: 'completed', jobs: [
      job(1, 'changes', 'linux'), job(2, 'go (ubuntu-latest)', 'linux'), job(3, 'go (windows-latest)', 'windows', 'failure'),
      job(4, 'app (${{ matrix.os }})', '', 'skipped'), job(5, 'odd', ''),
    ] }] as CIRun[]
    const g = jobGrid(runs)
    expect(g.families).toEqual(['changes', 'go', 'odd'])
    expect(g.oses).toEqual(['linux', 'windows', 'other'])
    expect(g.cell('go', 'windows')?.id).toBe(3)
    expect(g.cell('go', 'macos')).toBeUndefined()
    expect(g.cell('odd', 'other')?.id).toBe(5)
  })

  it('says times and shares short, and a figure against a median only when both exist', () => {
    expect(spanText(8 * 60_000)).toBe('8m')
    expect(spanText(130 * 60_000)).toBe('2h 10m')
    expect(spanText(52 * 3_600_000)).toBe('2d 4h')
    expect(spanText(20_000)).toBe('20s')
    expect(pctText(3, 47)).toBe('6.4%')
    expect(pctText(3, 20)).toBe('15%')
    expect(pctText(0, 5)).toBe('0%')
    expect(pctText(1, 0)).toBe('')
    expect(vsMedianText(118_000, 100_000)).toEqual({ text: '+18%', tone: 'muted' })
    expect(vsMedianText(130_000, 100_000)?.tone).toBe('warn')
    expect(vsMedianText(80_000, 100_000)?.tone).toBe('ok')
    expect(vsMedianText(80_000, undefined)).toBeUndefined()
  })

  it('leaves out a median of fewer than two and a red share without runs', () => {
    const st: RepoStats = {
      days: ['2026-10-12', '2026-10-13'], merged: [3, 2], ttm_count: 1, ttm_median_ms: 0, prs_listed: 50,
      ci: { runs: 0, red: 0, reruns: 0, listed: 0, per_day: [{ runs: 0, red: 0 }, { runs: 0, red: 0 }], workflows: [] },
    }
    const w = statsWords(st)
    expect(w.merged).toEqual({ total: 5, last7: 5, today: 2 })
    expect(w.ttm).toBeUndefined()
    expect(w.ttmNote).toBe('one merge: no median yet')
    expect(w.ci).toBeUndefined()
    expect(w.red).toBeUndefined()
    const busy = statsWords({ ...st, ttm_count: 4, ttm_median_ms: 8 * 60_000, ci: { ...st.ci, runs: 47, red: 3, reruns: 1, listed: 100, workflows: [{ name: 'ci', runs: 40, red: 3, median_ms: 430_000, median_runs: 37, daily_median_ms: [0, 0] }] } })
    expect(busy.ttm?.text).toBe('8m')
    expect(busy.ci).toEqual({ name: 'ci', text: '7m 10s', note: 'median of 37 successful runs' })
    expect(busy.red?.text).toBe('6.4%')
    expect(busy.red?.note).toBe('3 of 47 runs · 1 re-run')
  })

  it('lists this session’s, the repository’s or the open pull requests, and picks the session’s open one first', () => {
    const live = (n: number, state: 'open' | 'merged') => ({ number: n, url: `u${n}`, title: `t${n}`, state, draft: false, checks: { state: 'pass', passed: 1, failed: 0, pending: 0, items: [] } })
    const session = [
      { session_id: 's', url: 'u5', number: 5, last_at: 1, live: live(5, 'merged') },
      { session_id: 's', url: 'u9', number: 9, last_at: 2, live: live(9, 'open') },
      { session_id: 's', url: 'u2', number: 2, last_at: 0, merged_at: 3 },
    ] as unknown as SessionPRLive[]
    const repo: BranchPR[] = [
      { number: 11, url: 'u11', title: 'x', state: 'open' },
      { number: 9, url: 'u9', title: 't9', state: 'open' },
      { number: 5, url: 'u5', title: 't5', state: 'merged', created_at: 1, merged_at: 2 },
    ]
    expect(tabRows('session', session, repo).map((r) => r.number)).toEqual([9, 5, 2])
    const all = tabRows('repo', session, repo)
    // The session's #2, older than the repository's list, still shows.
    expect(all.map((r) => r.number)).toEqual([11, 9, 5, 2])
    expect(all.find((r) => r.number === 9)?.mine?.number).toBe(9)
    expect(all.find((r) => r.number === 11)?.mine).toBeUndefined()
    expect(tabRows('open', session, repo).map((r) => r.number)).toEqual([11, 9])
    expect(firstPick(all, session)).toBe(9)
    expect(firstPick(tabRows('repo', [], repo), [])).toBe(11)
    expect(firstPick([], [])).toBeUndefined()
  })

  // A session in dspv/caprock opened cybrixcc/caprock-web #247 (2026-11-19).
  it('keeps a pull request the session opened in another repository out of the repository’s scopes, matching by repository and number', () => {
    const live = (n: number, repo: string) => ({ number: n, url: `https://github.com/${repo}/pull/${n}`, repo, title: `t${n}`, state: 'open', draft: false, checks: { state: 'pass', passed: 1, failed: 0, pending: 0, items: [] } })
    const session = [
      { session_id: 's', url: 'https://github.com/c/web/pull/247', number: 247, last_at: 2, live: live(247, 'c/web') },
      // Read from its address alone: GitHub not read.
      { session_id: 's', url: 'https://github.com/c/web/pull/12', number: 12, last_at: 1 },
      { session_id: 's', url: 'https://github.com/a/b/pull/9', number: 9, last_at: 0, live: live(9, 'a/b') },
    ] as unknown as SessionPRLive[]
    const repo: BranchPR[] = [
      { number: 247, url: 'https://github.com/a/b/pull/247', title: 'own 247', state: 'open' },
      { number: 9, url: 'https://github.com/a/b/pull/9', title: 't9', state: 'open' },
    ]
    // Its own scope keeps them all, this repository's open one first, the others marked.
    const mineRows = tabRows('session', session, repo, 'a/b')
    expect(mineRows.map((r) => [r.number, r.foreign])).toEqual([[9, undefined], [247, 'c/web'], [12, 'c/web']])
    // The repository's #247 is not the session's.
    const all = tabRows('repo', session, repo, 'a/b')
    expect(all.map((r) => r.number)).toEqual([247, 9])
    expect(all.find((r) => r.number === 247)?.mine).toBeUndefined()
    expect(all.find((r) => r.number === 9)?.mine?.number).toBe(9)
    expect(all.some((r) => r.foreign)).toBe(false)
    expect(tabRows('open', session, repo, 'a/b').map((r) => r.number)).toEqual([247, 9])
    expect(firstPick(all, session, 'a/b')).toBe(9)
    // Without the repository's name nothing is foreign: as before.
    expect(tabRows('session', session, repo).some((r) => r.foreign)).toBe(false)
  })

  it('reads a pull request’s repository from GitHub’s answer or its address', () => {
    expect(prRepoOf({ url: 'https://github.com/cybrixcc/caprock-web/pull/247' })).toBe('cybrixcc/caprock-web')
    expect(prRepoOf({ url: 'x', live: { repo: 'dspv/caprock' } })).toBe('dspv/caprock')
    expect(prRepoOf({ url: 'not a pull request' })).toBeUndefined()
    expect(foreignRepo({ url: 'https://github.com/cybrixcc/caprock-web/pull/247' }, 'dspv/caprock')).toBe('cybrixcc/caprock-web')
    expect(foreignRepo({ url: 'https://github.com/DSPV/Caprock/pull/9' }, 'dspv/caprock')).toBeUndefined()
    expect(foreignRepo({ url: 'https://github.com/cybrixcc/caprock-web/pull/247' }, undefined)).toBeUndefined()
    expect(repoShort('cybrixcc/caprock-web')).toBe('caprock-web')
  })
})
