import { afterEach, describe, expect, it } from 'vitest'
import { headlineParts, JARVIS_MUTED_KEY, loadMuted, parseCommand, routeCommand, saveMuted, shownOf, suggest } from './jarvis'
import { jarvisFixture } from './jarvis.fixture'

afterEach(() => localStorage.clear())

const names = ['caprock', 'caprock-web', 'my notes']

describe('Jarvis, pure', () => {
  it('parses @project text, the longest project name first, names with spaces too', () => {
    expect(parseCommand('@caprock-web fix the footer', names)).toEqual({ kind: 'send', project: 'caprock-web', text: 'fix the footer' })
    expect(parseCommand('@caprock ship it', names)).toEqual({ kind: 'send', project: 'caprock', text: 'ship it' })
    expect(parseCommand('@My Notes tidy up', names)).toEqual({ kind: 'send', project: 'my notes', text: 'tidy up' })
    expect(parseCommand('fix the footer', names)).toEqual({ kind: 'hint', text: 'Start with @project, then what to do' })
    expect(parseCommand('@nowhere do it', names)).toEqual({ kind: 'hint', text: 'No project named nowhere' })
    expect(parseCommand('@caprock', names).kind).toBe('hint')
  })

  it('suggests project names while the first word after @ is typed', () => {
    expect(suggest('@cap', names)).toEqual(['caprock', 'caprock-web'])
    expect(suggest('@web', names)).toEqual(['caprock-web'])
    expect(suggest('@caprock do', names)).toEqual([])
    expect(suggest('cap', names)).toEqual([])
  })

  it('routes to the most recently active agent Caprock started, else to a new session in the folder', () => {
    const d = jarvisFixture()
    const r = routeCommand(d, 'caprock')
    expect(r.kind).toBe('queue')
    if (r.kind === 'queue') { expect(r.agent.session_id).toBe('a2'); expect(r.of).toBe(2) }
    // caprock-web: a4 is Caprock's, x1 is not; a4 takes it.
    const w = routeCommand(d, 'caprock-web')
    expect(w.kind === 'queue' && w.agent.session_id).toBe('a4')
    // Only a session from the person's own terminal: never typed into, a new one starts.
    d.agents = d.agents.filter((a) => a.session_id === 'x1')
    expect(routeCommand(d, 'caprock-web')).toEqual({ kind: 'spawn', dir: '/w/caprock-web', skipped: 1 })
    expect(routeCommand(d, 'notes')).toEqual({ kind: 'spawn', dir: undefined, skipped: 0 })
  })

  it('keeps the muted projects across visits, and survives storage that throws', () => {
    saveMuted(new Set(['caprock-web']))
    expect(localStorage.getItem(JARVIS_MUTED_KEY)).toBe('["caprock-web"]')
    expect([...loadMuted()]).toEqual(['caprock-web'])
    saveMuted(new Set())
    expect(localStorage.getItem(JARVIS_MUTED_KEY)).toBeNull()
    localStorage.setItem(JARVIS_MUTED_KEY, '{not json')
    expect(loadMuted().size).toBe(0)
  })

  it('hides a muted project everywhere, and narrows to one picked project', () => {
    const d = jarvisFixture()
    const s = shownOf(d, new Set(['caprock-web']))
    // The task runner's approval (no session, no project) stays: no chip owns it.
    expect(s.needs.map((n) => n.session_id)).toEqual(['a1', 'a2', ''])
    expect(shownOf(d, new Set(), 'caprock').needs.map((n) => n.kind)).toEqual(['permission', 'question', 'approval'])
    expect(s.agents.map((a) => a.session_id)).toEqual(['a1', 'a2'])
    expect(shownOf(d, new Set(), 'caprock-web').agents.map((a) => a.session_id)).toEqual(['a4', 'x1'])
  })

  it('writes the headline in the owner’s order, stuck only when there is any', () => {
    const h = jarvisFixture().headline
    expect(headlineParts(h).map((p) => p.text)).toEqual(['3 working', '2 waiting for you', '101 sessions today'])
    expect(headlineParts({ ...h, stuck: 1 }).map((p) => p.text)).toContain('1 stuck')
  })
})
