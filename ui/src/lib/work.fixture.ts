/**
 * A Work board answer and one repository's Pipeline answer, for the tests and
 * the page's preview. Made-up figures, for tests only — not measurements.
 */
import type { SessionCIStats, Work, WorkSession } from './api'

export const NOW = 1_800_000_000_000
const MIN = 60_000

export const session = (id: string, p: Partial<WorkSession> = {}): WorkSession => ({
  session_id: id, agent: 'claude', owned: true, project: 'caprock', repo_root: '/w/caprock', started_at: NOW - 30 * MIN,
  state: 'working', cost_usd: 1, today_usd: 1, prs: [], link: 'none', ...p,
})

export function workFixture(): Work {
  return {
    now: NOW,
    day_start: NOW - 10 * 60 * MIN,
    hive: 'on',
    sessions: [
      session('s1', {
        name: 'Folder search', model_display: 'Opus 4.1', branch: 'feat/folder-search', started_at: NOW - 40 * MIN,
        turn_started_at: NOW - 2 * MIN, turn_left: { lo_ms: 1 * MIN, mid_ms: 2 * MIN, hi_ms: 4 * MIN },
        estimate: { turns: 12, p25_ms: 2 * MIN, median_ms: 3 * MIN, p75_ms: 6 * MIN }, todo: { active: 'Writing tests', done: 3, total: 7 },
        cost_usd: 4.2, today_usd: 4.2, link: 'recorded',
        prs: [{ number: 629, url: 'https://github.com/dspv/caprock/pull/629', opened_at: NOW - 300 * MIN, merged_at: NOW - 200 * MIN }, { number: 631, url: 'https://github.com/dspv/caprock/pull/631', title: 'folder search', opened_at: NOW - 30 * MIN }],
      }),
      session('s2', { owned: false, model_display: 'Sonnet 4.5', branch: 'feat/pipeline-dash', state: 'permission', started_at: NOW - 20 * MIN, cost_usd: 2.5, today_usd: 2.5 }),
      session('s3', { agent: 'codex', project: 'site', repo_root: '/w/site', state: 'at_prompt', started_at: NOW - 300 * MIN, worked_at: NOW - 120 * MIN, cost_usd: 0.4, today_usd: 0.4 }),
      session('s4', { name: 'Input highlight', branch: 'feat/input-hl', state: 'at_prompt', worked_at: NOW - 5 * MIN, started_at: NOW - 90 * MIN, cost_usd: 3, today_usd: 3, link: 'branch',
        prs: [{ number: 633, url: 'https://github.com/dspv/caprock/pull/633', title: 'input highlight', opened_at: NOW - 60 * MIN }] }),
    ],
    tasks: [
      { id: 't1', title: 'Work: list screen', status: 'inbox', budget_usd: 5, spent_usd: 0 },
      { id: 't2', title: 'Pipeline in Dashboard', status: 'in_progress', session_id: 's2', budget_usd: 10, spent_usd: 2.5 },
      { id: 't3', title: 'Old thing', status: 'done', budget_usd: 1, spent_usd: 1 },
    ],
    queued: [{ session_id: 's1', position: 1, text: 'Then add the Kanban view\nwith five columns', start: { lo_ms: MIN, mid_ms: 2 * MIN, hi_ms: 4 * MIN }, finish: { lo_ms: 5 * MIN, mid_ms: 8 * MIN, hi_ms: 14 * MIN } }],
    repos: [
      {
        root: '/w/caprock', name: 'caprock', remote: 'dspv/caprock', via_session: 's1', live: 3,
        unreleased: { ref: 'origin/master', items: ['Mail on its own at ?mail=1', 'No console window flashes on Windows', 'A Second Brain banner'], count: 5, more: true },
        tags: { last: { name: 'v0.117.4', at: NOW - 125 * MIN }, gap_median_ms: 160 * MIN, gaps: 9 }, ahead_of_tag: 6,
      },
      { root: '/w/site', name: 'site', via_session: 's3', live: 1 },
    ],
    totals: { live: 4, working: 1, waiting_you: 1, today_usd: 10.1, machine_today_usd: 31.7 },
  }
}

export function statsFixture(): SessionCIStats {
  const pr = (number: number, head: string, state: 'open' | 'merged' | 'closed', title: string, created: number, merged?: number) =>
    ({ number, url: `https://github.com/dspv/caprock/pull/${number}`, title, state, head, created_at: NOW - created * MIN, merged_at: merged ? NOW - merged * MIN : undefined })
  return {
    connected: true,
    repo: 'dspv/caprock',
    prs: [
      pr(631, 'feat/folder-search', 'open', 'folder search', 30),
      pr(633, 'feat/input-hl', 'open', 'input highlight', 60),
      pr(630, 'fix/quiet-server', 'merged', 'an account check ends within 30 seconds', 200, 50),
      pr(625, 'feat/brain-banner', 'merged', 'a Second Brain banner', 400, 300),
      pr(620, 'feat/dropped', 'closed', 'a dropped idea', 900),
      pr(629, 'feat/folder-search-1', 'merged', 'folder search, first cut', 300, 200),
    ],
    board: {
      cards: [
        { number: 631, stage: 'open', ci: 'running', stage_at: NOW - 6 * MIN, spend: { cost_usd: 5.1, sessions: 2, live: 1, agents: ['claude'] } },
        { number: 633, stage: 'ready', ci: 'pass', stage_at: NOW - 10 * MIN, spend: { cost_usd: 3, sessions: 1, live: 1, agents: ['claude'] } },
        { number: 630, stage: 'merged', stage_at: NOW - 50 * MIN, spend: { cost_usd: 1.2, sessions: 1, live: 0, agents: ['claude'] } },
        { number: 629, stage: 'merged', stage_at: NOW - 200 * MIN, spend: { cost_usd: 0.8, sessions: 1, live: 0, agents: ['claude'] } },
        { number: 625, stage: 'released', release: 'v0.117.4', stage_at: NOW - 125 * MIN, spend: { cost_usd: 2, sessions: 1, live: 0, agents: ['claude'] } },
      ],
      releases: [],
      ships_by: 'release',
      flow: {
        counts: { draft: 0, open: 1, fix: 0, ready: 1, merged: 2, released: 1 }, days: 14, merged: 20, ttm_count: 20,
        ci_median_ms: 11 * MIN, release_lag_median_ms: 120 * MIN, release_lag_count: 7, release_gap_median_ms: 160 * MIN, release_gap_count: 9, cost_usd: 40,
      },
    },
  }
}
