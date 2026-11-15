import type { JarvisDigest } from './api'

/** A fixed clock for the Jarvis fixture: 2026-11-15 10:00 UTC. */
export const JNOW = Date.UTC(2026, 10, 15, 10, 0, 0)

/** A digest in the exact shape of GET /v1/jarvis: two projects, one session from the person's own terminal. */
export function jarvisFixture(): JarvisDigest {
  return {
    generated_at: JNOW,
    headline: { working: 3, waiting_you: 2, stuck: 0, live: 5, sessions_today: 101, cost_today_usd: 101 },
    needs_you: [
      { kind: 'permission', session_id: 'a1', project: 'caprock', title: 'Jarvis screen', detail: 'npm test', since: JNOW - 120_000, controllable: true },
      { kind: 'question', session_id: 'a2', project: 'caprock', title: 'Release notes', detail: 'Which version should it say?', since: JNOW - 300_000, controllable: true },
      { kind: 'approval', session_id: '', project: '', title: 'Task to approve: Pricing page', detail: 'Pricing page', since: JNOW - 400_000, approval_id: 't9', controllable: true },
      { kind: 'loop', session_id: 'a4', project: 'caprock-web', title: 'Fix CI', detail: 'Bash ran the same command 6 times', since: JNOW - 500_000, controllable: true },
      { kind: 'question', session_id: 'x1', project: 'caprock-web', title: 'Own terminal', since: JNOW - 600_000, controllable: false },
    ],
    agents: [
      { session_id: 'a1', project: 'caprock', dir: '/w/caprock', agent: 'claude', title: 'Jarvis screen', state: 'waiting', now: 'Asking to run npm test', plan: { done: 3, total: 8, current: 'Write the tests' }, cost_today_usd: 4.2, started_at: JNOW - 3_600_000, last_activity_at: JNOW - 120_000, controllable: true },
      { session_id: 'a2', project: 'caprock', dir: '/w/caprock', agent: 'codex', title: 'Release notes', state: 'working', now: 'Editing CHANGELOG.md', plan: null, cost_today_usd: 1.1, started_at: JNOW - 1_800_000, last_activity_at: JNOW - 10_000, controllable: true },
      { session_id: 'a4', project: 'caprock-web', dir: '/w/caprock-web', agent: 'claude', title: 'Fix CI', state: 'stuck', now: 'Running npm run build', plan: { done: 1, total: 4, current: 'Fix the build' }, cost_today_usd: 7.5, started_at: JNOW - 7_200_000, last_activity_at: JNOW - 60_000, controllable: true },
      { session_id: 'x1', project: 'caprock-web', dir: '/w/caprock-web', agent: 'claude', title: 'Own terminal', state: 'idle', now: 'At its prompt', plan: null, cost_today_usd: 0.4, started_at: JNOW - 9_000_000, last_activity_at: JNOW - 900_000, controllable: false },
    ],
    projects: [
      { name: 'caprock', live: 2, waiting: 2 },
      { name: 'caprock-web', live: 2, waiting: 1 },
      { name: 'notes', live: 0, waiting: 0 },
    ],
  }
}
