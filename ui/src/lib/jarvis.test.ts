import { afterEach, describe, expect, it, vi } from 'vitest'
import { brainCardHidden, BRAIN_LATER_MS, brainWord, chatTarget, clockTime, handledLine, headlineParts, hideBrainCard, isDoneMessage, isHidden, JARVIS_BRAIN_LATER_KEY, JARVIS_DISMISSED_KEY, JARVIS_LATER_KEY, JARVIS_MUTED_KEY, loadDismissed, loadLater, loadMuted, mergeHandled, mergeMessages, needKey, needPrint, optionLabel, parseCommand, pruneHidden, routeCommand, saveDismissed, saveLater, saveMuted, shownOf, shownOptions, suggest, tapAnswerable } from './jarvis'
import type { JarvisNeed } from './api'
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

describe('Jarvis V2, pure', () => {
  const q = (extra: Partial<JarvisNeed> = {}): JarvisNeed => ({
    kind: 'question', session_id: 's1', project: 'p', title: 't', detail: 'Which one?', since: 1000, controllable: true, answerable: true,
    options: [{ label: 'A', recommended: false }, { label: 'B (Recommended)', recommended: false }, { label: 'C', recommended: true }],
    ...extra,
  })

  it('strips “(Recommended)”, stars one option first, and keeps each option’s own index', () => {
    expect(optionLabel('R2 bucket (Recommended)')).toBe('R2 bucket')
    expect(optionLabel('(recommended) Local')).toBe('Local')
    const o = shownOptions(q().options)
    expect(o.map((x) => [x.index, x.label, x.recommended])).toEqual([[1, 'B', true], [0, 'A', false], [2, 'C', false]])
    expect(shownOptions([{ label: 'x', recommended: false }]).map((x) => x.recommended)).toEqual([false])
    expect(shownOptions(undefined)).toEqual([])
  })

  it('answers by tap only an answerable single question of a session Caprock started, on a device that controls', () => {
    expect(tapAnswerable(q(), true)).toBe(true)
    expect(tapAnswerable(q(), false)).toBe(false)
    expect(tapAnswerable(q({ controllable: false }), true)).toBe(false)
    expect(tapAnswerable(q({ answerable: false }), true)).toBe(false)
    expect(tapAnswerable(q({ more_questions: 1 }), true)).toBe(false)
    expect(tapAnswerable(q({ options: [] }), true)).toBe(false)
    expect(tapAnswerable(q({ kind: 'permission' }), true)).toBe(false)
  })

  it('hides for an hour with Later, until the need changes with Dismiss, and forgets what no longer applies', () => {
    const n = q()
    const k = needKey(n)
    expect(isHidden(n, { [k]: 5000 }, {}, 4000)).toBe(true)
    expect(isHidden(n, { [k]: 5000 }, {}, 6000)).toBe(false)
    expect(isHidden(n, {}, { [k]: needPrint(n) }, 0)).toBe(true)
    expect(isHidden({ ...n, since: 2000 }, {}, { [k]: needPrint(n) }, 0)).toBe(false)
    const p = pruneHidden([n], { [k]: 5000, 'question:gone:': 9000 }, { [k]: 'old print', 'loop:x:': 'p' }, 4000)
    expect(p).toEqual({ later: { [k]: 5000 }, dismissed: {} })
    saveLater({ [k]: 5000 })
    expect(loadLater()).toEqual({ [k]: 5000 })
    saveDismissed({})
    expect(localStorage.getItem(JARVIS_DISMISSED_KEY)).toBeNull()
    localStorage.setItem(JARVIS_LATER_KEY, '[1,2]')
    expect(loadLater()).toEqual({})
    localStorage.setItem(JARVIS_DISMISSED_KEY, '{"a":1,"b":"x"}')
    expect(loadDismissed()).toEqual({ b: 'x' })
  })

  it('targets @project first, then the chip picked, then the project worked in last, never a muted one', () => {
    const d = jarvisFixture()
    expect(chatTarget('@caprock-web fix it', names, '', d)).toEqual({ project: 'caprock-web', by: 'mention', text: 'fix it' })
    expect(chatTarget('@My Notes tidy', names, '', d)).toEqual({ project: 'my notes', by: 'mention', text: 'tidy' })
    expect(chatTarget('fix it', names, 'caprock-web', d)).toEqual({ project: 'caprock-web', by: 'chip', text: 'fix it' })
    // a2 in caprock has the newest activity.
    expect(chatTarget('fix it', names, '', d)).toEqual({ project: 'caprock', by: 'recent', text: 'fix it' })
    expect(chatTarget('fix it', names, '', d, new Set(['caprock']))?.project).toBe('caprock-web')
    expect(chatTarget('fix it', names, '', { ...d, agents: [] })).toBeNull()
    expect(chatTarget('@nowhere x', names, '', { ...d, agents: [] })).toBeNull()
  })

  it('words the summary’s handled sentence, the brain’s state and “Done:” messages', () => {
    expect(handledLine(0)).toBe('')
    expect(handledLine(undefined)).toBe('')
    expect(handledLine(1)).toBe(' I handled 1 thing myself today.')
    expect(handledLine(5)).toBe(' I handled 5 things myself today.')
    expect(brainWord(undefined)).toBeNull()
    expect(brainWord({ state: 'ready', agent: 'codex', auto_answer: 'routine' })).toEqual({ text: 'Codex · ready', tone: 'ok' })
    expect(brainWord({ state: 'signed-out', agent: 'claude', auto_answer: 'routine' })?.tone).toBe('warn')
    expect(brainWord({ state: 'off', auto_answer: 'off' })?.text).toBe('Brain off')
    expect(isDoneMessage({ role: 'jarvis', text: 'Done: "x" in y finished.' })).toBe(true)
    expect(isDoneMessage({ role: 'user', text: 'Done: mine' })).toBe(false)
  })

  it('merges the thread by id oldest first, and Handled for you newest first', () => {
    const m = (id: number, at: number, text = '') => ({ id, at, role: 'jarvis' as const, text })
    expect(mergeMessages([m(1, 10), m(2, 20, 'old')], [m(2, 20, 'new'), m(3, 5)]).map((x) => [x.id, x.text])).toEqual([[3, ''], [1, ''], [2, 'new']])
    const hi = (id: number, at: number) => ({ id, at, kind: 'morning' as const, text: '' })
    expect(mergeHandled([hi(1, 10)], [hi(2, 30), hi(1, 10)]).map((x) => x.id)).toEqual([2, 1])
  })

  it('remembers Not now on the brain card for a week, and survives storage that throws', () => {
    expect(brainCardHidden(0)).toBe(false)
    hideBrainCard(1000)
    expect(brainCardHidden(1000 + BRAIN_LATER_MS - 1)).toBe(true)
    expect(brainCardHidden(1000 + BRAIN_LATER_MS)).toBe(false)
    expect(Number(localStorage.getItem(JARVIS_BRAIN_LATER_KEY))).toBe(1000 + BRAIN_LATER_MS)
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    try { expect(brainCardHidden(0)).toBe(false); expect(loadLater()).toEqual({}) } finally { get.mockRestore() }
  })

  it('writes clock times as HH:MM', () => {
    expect(clockTime(new Date(2026, 10, 16, 9, 5).getTime())).toBe('09:05')
  })
})
