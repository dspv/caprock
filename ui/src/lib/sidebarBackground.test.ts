import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import { BACKGROUND_IDLE_MS, inTempDir, isBackgroundSession, UNTITLED_GRACE_MS } from './sidebar'

const NOW = Date.UTC(2026, 9, 20, 12, 0)
const H = 60 * 60 * 1000

// Shaped like rows the owner's sidebar listed under "Running, no tab" on
// 2026-10-20: an ops run in a temp folder, a scout another tool launched with
// a scripted brief, and his own session.
const row = (p: Partial<SessionSummary>): SessionSummary => ({
  session_id: 's', cwd: '/Users/me/dev/caprock', project: 'caprock', model: 'claude-opus-5-5',
  started_at: NOW - 2 * H, last_event_at: NOW - H, status: 'active', transcript_path: '', has_hooks: true,
  has_transcript: true, git_branch: 'master', version: '', owned: true,
  activity: { phrase: '', at: new Date(NOW - H).toISOString(), health: 'idle' },
  ...p,
}) as SessionSummary

const scoutBrief = [
  'You are a scout. Find threads on X and Reddit where people ask how to watch several Claude Code sessions at once.',
  'For each thread: the URL, the question, how many replies, and whether Caprock would answer it.',
  'Rules: read only, never post, never log in. Stop after 25 threads.',
  'Output: a JSON list, one object per thread, nothing else.',
].join('\n')

describe('what folds under Background', () => {
  it('folds an untitled session in a macOS temp folder', () => {
    const s = row({ cwd: '/private/var/folders/7k/x1y2z3/T/ops-seo-site-66tben_l', owned: true, title: undefined, description: '' })
    expect(isBackgroundSession(s, { now: NOW })).toBe(true)
  })

  it('folds a temp-folder session even while it works and has a title', () => {
    const s = row({ cwd: '/tmp/helper-run', title: 'Check the links', activity: { phrase: '', at: new Date(NOW).toISOString(), health: 'working' } })
    expect(isBackgroundSession(s, { now: NOW })).toBe(true)
  })

  it('folds a Codex scout another tool started with a scripted brief', () => {
    const s = row({ agent: 'codex', owned: false, title: undefined, description_source: 'prompt', description: scoutBrief, cwd: '/Users/me/dev/caprock-web' })
    expect(isBackgroundSession(s, { now: NOW })).toBe(true)
  })

  it('keeps an owned Claude session with a title active an hour ago', () => {
    const s = row({ title: 'Vibe coding setup', description_source: 'title', description: 'Vibe coding setup' })
    expect(isBackgroundSession(s, { now: NOW })).toBe(false)
  })

  it('keeps a session the user started in his own terminal, titled, with a short prompt', () => {
    const s = row({ owned: false, title: undefined, description_source: 'prompt', description: 'fix the flaky Windows test in hookd' })
    expect(isBackgroundSession(s, { now: NOW })).toBe(false)
  })

  it('keeps a long prompt the user typed into a session Caprock started', () => {
    const s = row({ owned: true, title: undefined, description_source: 'prompt', description: scoutBrief })
    expect(isBackgroundSession(s, { now: NOW })).toBe(false)
  })

  it('folds a session with no title once it is past its first minutes', () => {
    const s = row({ title: undefined, description: '', started_at: NOW - UNTITLED_GRACE_MS - 1000 })
    expect(isBackgroundSession(s, { now: NOW })).toBe(true)
    expect(isBackgroundSession({ ...s, started_at: NOW - 60_000 }, { now: NOW })).toBe(false)
    // A name the user gave it is a title.
    expect(isBackgroundSession({ ...s, name: 'Release notes' }, { now: NOW })).toBe(false)
  })

  it('folds a titled session nothing happened in for a day, unless it works now', () => {
    const old = NOW - BACKGROUND_IDLE_MS - H
    const s = row({ title: 'Old work', started_at: old - H, last_event_at: old, worked_at: old, activity: { phrase: '', at: new Date(old).toISOString(), health: 'idle' } })
    expect(isBackgroundSession(s, { now: NOW })).toBe(true)
    expect(isBackgroundSession({ ...s, activity: { ...s.activity, health: 'working' } }, { now: NOW })).toBe(false)
  })

  it('keeps a temp-folder session in a project added by hand (the daemon never lists one itself)', () => {
    const s = row({ cwd: '/private/var/folders/7k/x/T/caprock-e2e-1/home/dev/alpha', name: 'e2e alpha' })
    expect(isBackgroundSession(s, { now: NOW, inProject: true })).toBe(false)
    expect(isBackgroundSession(s, { now: NOW })).toBe(true)
  })

  it('never folds one that asks for a permission', () => {
    const s = row({ cwd: '/private/var/folders/7k/x/T/ops-run', title: undefined })
    expect(isBackgroundSession(s, { now: NOW, hasPermission: true })).toBe(false)
  })
})

describe('temporary folders', () => {
  it('names the usual places on every OS', () => {
    for (const p of ['/private/var/folders/ab/cd/T/x', '/var/folders/ab/cd/T', '/tmp', '/tmp/x', '/private/tmp/x', '/var/tmp/y', 'C:\\Users\\me\\AppData\\Local\\Temp\\run-1']) {
      expect(inTempDir(p), p).toBe(true)
    }
    for (const p of ['/Users/me/dev/tmp-notes', '/Users/me/tmp', '/home/me/dev/caprock', 'D:\\work\\Temp', '', undefined]) {
      expect(inTempDir(p), String(p)).toBe(false)
    }
  })
})
