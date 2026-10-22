/**
 * Needs you and Done (.ai/04-ui.md § Needs you and Done): a turn that ended
 * asking nothing is Done — listed, never counted, never in the badge — and
 * every screen reads the same split from the daemon's `activity.need`.
 */
import { describe, expect, it } from 'vitest'
import type { Need, SessionSummary } from './api'
import { needLabel, needWord, oldestFirst, reasonsSentence } from './needs'
import { buildPopover } from './traydata'
import { buildTrayView } from './tray'
import { buildSidebar, dotOf } from './sidebar'
import { findAttention } from './attention'
import { continueRows, waitingOnYou } from './phonehome'
import { atPrompt } from './sessionJump'

const NOW = Date.parse('2026-10-21T12:00:00Z')

function sess(id: string, health: SessionSummary['activity']['health'], need?: Need, agoMin = 1): SessionSummary {
  const at = new Date(NOW - agoMin * 60_000).toISOString()
  return {
    session_id: id, cwd: '/w/app', repo_root: '/w/app', project: 'app', model: 'claude-opus-5', started_at: NOW - 60 * 60_000,
    last_event_at: NOW - agoMin * 60_000, worked_at: NOW - agoMin * 60_000,
    status: 'active', transcript_path: '', has_hooks: true, has_transcript: true, git_branch: 'main', version: '', owned: true, kind: 'agent',
    stats: { session_id: id, turns: 1, tool_calls: 0, files_touched: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0 },
    activity: { phrase: health === 'done' ? 'done' : 'waiting for you', at, health, need },
    savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 },
  } as unknown as SessionSummary
}

const asks: Need = { reason: 'asks', detail: 'question', text: 'Merge it?', guess: true }
const done: Need = { reason: 'done', text: 'Pushed the branch.', guess: true }

describe('the words', () => {
  it('labels each reason, certain and guessed', () => {
    expect(needLabel({ reason: 'permission' })).toBe('permission')
    expect(needLabel({ reason: 'question' })).toBe('asks a question')
    expect(needLabel({ reason: 'plan' })).toBe('plan to approve')
    expect(needLabel({ reason: 'error', detail: 'rate limit' })).toBe('stopped: rate limit')
    expect(needLabel({ ...asks, detail: 'choice' })).toBe('asks a choice')
    expect(needLabel(done)).toBe('done')
    expect(needLabel({ reason: 'asks', moved: true })).toBe('you marked it')
  })

  it('gives a native menu one word, a guess with a trailing "?"', () => {
    expect(needWord(asks)).toBe('question?')
    expect(needWord({ reason: 'question' })).toBe('question')
    expect(needWord({ reason: 'error', detail: 'x' })).toBe('error')
  })

  it('names the rest of the queue by what they want, oldest first', () => {
    const list = oldestFirst([sess('b', 'waiting-on-you', asks, 2), sess('a', 'waiting-on-you', { reason: 'plan' }, 9)])
    expect(list.map((s) => s.session_id)).toEqual(['a', 'b'])
    expect(reasonsSentence(list)).toBe('a plan, a question (guess)')
  })
})

describe('every screen keeps Done apart', () => {
  const needs = sess('needs', 'waiting-on-you', asks, 20)
  const fin = sess('done', 'done', done, 20)
  const work = sess('work', 'working')

  it('Home: Done is never a Needs you row', () => {
    const items = findAttention({ sessions: [needs, fin, work], alerts: [], now: NOW })
    expect(items.map((i) => i.sessionId)).toEqual(['needs'])
    expect(items[0]!.need).toEqual(asks)
    expect(items[0]!.detail).toBe('“Merge it?”')
  })

  it('sidebar: Done has its own dot and list, not the inbox', () => {
    expect(dotOf(fin, false)).toBe('done')
    const m = buildSidebar({ projects: [], sessions: [needs, fin, work], permissions: new Set(), costs: new Map(), openSessions: new Set(), now: NOW })
    expect(m.inbox.map((i) => i.session.session_id)).toEqual(['needs'])
    expect(m.done.map((i) => i.session.session_id)).toEqual(['done'])
  })

  it('tray: the badge counts Needs you; Done goes to a submenu', () => {
    const m = buildSidebar({ projects: [], sessions: [needs, fin], permissions: new Set(), costs: new Map(), openSessions: new Set(), now: NOW })
    const v = buildTrayView({ inbox: m.inbox, done: m.done, conn: 'open', now: NOW })
    expect(v.waiting.map((w) => w.id)).toEqual(['needs'])
    expect(v.waiting[0]!.label).toMatch(/ · question\?$/)
    expect(v.done?.map((w) => w.id)).toEqual(['done'])
    expect(v.done?.[0]!.label).not.toMatch(/done$/)
    expect(v.title).toBe('1 waiting')
  })

  it('popover: Needs you, then Done, never Running', () => {
    const p = buildPopover({ sessions: [needs, fin, work], permissions: new Map(), now: NOW })
    expect(p.waiting.map((r) => r.session.session_id)).toEqual(['needs'])
    expect(p.done.map((r) => r.session.session_id)).toEqual(['done'])
    expect(p.live.map((r) => r.session.session_id)).toEqual(['work'])
    const calm = buildPopover({ sessions: [fin], permissions: new Map(), now: NOW })
    expect(calm.calm).toBe(true)
  })

  it('phone: the card counts Needs you; a Done turn keeps its place in Continue', () => {
    expect(waitingOnYou([fin, needs]).map((s) => s.session_id)).toEqual(['needs'])
    const tabs = { known: true, at: NOW, sessions: ['done', 'needs', 'work'], items: [fin, needs, work] }
    expect(continueRows(tabs, false, []).rows.map((s) => s.session_id)).toEqual(['done', 'needs', 'work'])
  })

  it('a Done or a guessed turn sits at its prompt; a dialog does not', () => {
    expect(atPrompt(fin)).toBe(true)
    expect(atPrompt(needs)).toBe(true)
    const dialog = sess('p', 'waiting-on-you', { reason: 'permission' })
    dialog.activity.phrase = 'waiting for approval — running `make`'
    dialog.activity.tool = 'Bash'
    expect(atPrompt(dialog)).toBe(false)
  })
})
