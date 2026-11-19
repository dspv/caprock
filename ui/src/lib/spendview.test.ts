import { describe, expect, it } from 'vitest'
import { costNote, metricTitle, spendFigures, getSpendPick, periodChip, resetSpendPrefsForTest, setSpendScope, setSpendWindow, shownPick, spendLabel, windowFigures, windowStart, WHOLE_SESSION, barCarries, barValue, burnRate, chartTotal, chartValueText, foldedFigures, periodBurn, metricValue, migrateSpendPrefs, normalizeHero, normalizeSlots, normalizeSpendPrefs, rangeFigures, pickHero, pickSlot, shownSlots, type SpendBar, type SpendFigures } from './spendview'
import type { CallPoint } from './scrub'
import type { SessionSummary, Summary } from './api'

const call = (id: number, ts: number, cost: number): CallPoint => ({ id, ts, cost })
const H = 3_600_000

describe('the spend figures', () => {
  it('keeps three distinct figures, swaps on a pick, and never repeats the figures beside the agent', () => {
    expect(normalizeSlots(undefined)).toEqual(['cost', 'tokens', 'cache'])
    expect(normalizeSlots(['burn', 'burn', 'nope'])).toEqual(['burn', 'cost', 'tokens'])
    expect(normalizeSlots(['last', 'time', 'turns', 'tools'])).toEqual(['last', 'time', 'turns'])
    // Picking a figure another slot shows swaps the two.
    expect(pickSlot(['cost', 'tokens', 'cache'], 0, 'cache')).toEqual(['cache', 'tokens', 'cost'])
    expect(pickSlot(['cost', 'tokens', 'cache'], 1, 'burn')).toEqual(['cost', 'burn', 'cache'])
    // The figures beside the agent are shown already: their slots show the next ones not shown.
    expect(shownSlots(['cost', 'tokens', 'cache'], WHOLE_SESSION, ['cost', 'burn', 'tokens'])).toEqual(['last', 'time', 'cache'])
    expect(shownSlots(['cost', 'tokens', 'cache'], WHOLE_SESSION, ['turns', 'last', 'tools'])).toEqual(['cost', 'tokens', 'cache'])
    // Every session's period, or a part of this one, is another figure: it keeps it.
    expect(shownSlots(['cost', 'tokens', 'cache'], { scope: 'all', window: '7d' }, ['cost', 'burn', 'tokens'])).toEqual(['cost', 'tokens', 'cache'])
    expect(shownSlots(['cost', 'tokens', 'cache'], { scope: 'session', window: 'today' }, ['cost', 'burn', 'tokens'])).toEqual(['cost', 'tokens', 'cache'])
    const all = ['cost', 'burn', 'tokens', 'turns', 'cache', 'time', 'last', 'tools'] as const
    for (const a of all) for (const b of all) for (const c of all) {
      if (a === b || b === c || a === c) continue
      const shown = shownSlots(['cost', 'tokens', 'cache'], WHOLE_SESSION, [a, b, c])
      for (const m of [a, b, c]) expect(shown).not.toContain(m)
      expect(new Set(shown).size).toBe(3)
    }
  })

  it('keeps three distinct figures beside the agent and swaps on a pick', () => {
    expect(normalizeHero(undefined)).toEqual(['burn', 'tokens', 'cost'])
    expect(normalizeHero(['last', 'last', 'nope'])).toEqual(['last', 'burn', 'tokens'])
    expect(pickHero(['cost', 'burn', 'tokens'], 1, 'cache')).toEqual(['cost', 'cache', 'tokens'])
    // A taken one swaps: the headline moves to the line, the line's metric becomes the headline.
    expect(pickHero(['cost', 'burn', 'tokens'], 0, 'tokens')).toEqual(['tokens', 'burn', 'cost'])
    expect(pickHero(['cost', 'burn', 'tokens'], 2, 'burn')).toEqual(['cost', 'tokens', 'burn'])
  })

  it('measures the burn rate over the hour ending at the newest call', () => {
    const t = 10 * H
    // $5 more than an hour before the newest call is outside the window.
    expect(burnRate([call(1, t - 2 * H, 5), call(2, t - 30 * 60_000, 1), call(3, t, 2)], t - 3 * H)).toEqual({ perHour: 3, minutes: 60 })
    // A 30-minute-old session: $2 over half an hour is $4 an hour.
    expect(burnRate([call(1, t - 30 * 60_000, 1), call(2, t, 1)], t - 30 * 60_000)).toEqual({ perHour: 4, minutes: 30 })
    // Two calls a second apart are measured over five minutes, not one second.
    expect(burnRate([call(1, t - 1000, 1), call(2, t, 1)])).toEqual({ perHour: 24, minutes: 5 })
    expect(burnRate([call(1, t, 1)])).toBeUndefined()
  })

  it('reads stored choices field by field, unfolded on the chart by default, and 0.111.0’s views as Numbers or Chart', () => {
    expect(normalizeSpendPrefs(undefined)).toEqual({ folded: false, hero: ['burn', 'tokens', 'cost'], headline: 'burn', view: 'chart', slots: ['cost', 'tokens', 'cache'], chartBy: 'cost' })
    expect(normalizeSpendPrefs({ folded: true, headline: 'nope', view: 'numbers', period: '7d', slots: ['turns'] }))
      .toEqual({ folded: true, hero: ['burn', 'tokens', 'cost'], headline: 'burn', view: 'numbers', slots: ['turns', 'cost', 'tokens'], chartBy: 'cost' })
    // One stored headline, from before the three figures, stays the big one.
    expect(normalizeSpendPrefs({ headline: 'tokens' })).toMatchObject({ hero: ['tokens', 'burn', 'cost'], headline: 'tokens' })
    expect(normalizeSpendPrefs({ hero: ['turns', 'cache', 'turns'] })).toMatchObject({ hero: ['turns', 'cache', 'burn'], headline: 'turns' })
    // 0.111.0 stored Compact | Full: Full drew the chart, Compact the figures.
    expect(normalizeSpendPrefs({ view: 'full', chart: false }).view).toBe('chart')
    expect(normalizeSpendPrefs({ view: 'compact', chart: true }).view).toBe('numbers')
    expect(normalizeSpendPrefs({ view: 'tiny', period: '90d' })).toMatchObject({ view: 'chart' })
    // The period is each tab's own now, never a stored choice.
    expect(normalizeSpendPrefs({ period: '7d' })).not.toHaveProperty('period')
    expect(normalizeSpendPrefs({ chart: true })).not.toHaveProperty('chart')
  })

  it('opens every choice stored before version 2 on the chart, once', () => {
    // Numbers and folded were the old defaults: nobody can tell them from a pick.
    expect(migrateSpendPrefs({ view: 'numbers', folded: true, period: '7d' })).toEqual({ view: 'chart', folded: false })
    expect(migrateSpendPrefs({ v: 2, view: 'numbers', folded: true })).toEqual({ v: 2, view: 'numbers', folded: true })
    expect(migrateSpendPrefs(undefined)).toBeUndefined()
  })

  it('gives a stored hero that is exactly the old default the new one, and keeps any picked order', () => {
    expect(migrateSpendPrefs({ v: 2, hero: ['cost', 'burn', 'tokens'], period: '7d' }))
      .toEqual({ v: 2, hero: ['burn', 'tokens', 'cost'], headline: 'burn' })
    expect(migrateSpendPrefs({ v: 2, hero: ['tokens', 'cost', 'burn'] })).toEqual({ v: 2, hero: ['tokens', 'cost', 'burn'] })
    expect(migrateSpendPrefs({ v: 3, hero: ['cost', 'burn', 'tokens'] })).toEqual({ v: 3, hero: ['cost', 'burn', 'tokens'] })
  })

  it('drops a stored period once, keeping every other choice as picked', () => {
    // Before 6 one period served every tab: 'today', picked once, put the
    // same chart and dollars in every tab's cockpit.
    const v5 = { v: 5, view: 'numbers', folded: true, hero: ['tokens', 'cost', 'burn'], period: 'today', slots: ['turns', 'cost', 'cache'], chartBy: 'burn' }
    expect(migrateSpendPrefs(v5)).toEqual({ v: 5, view: 'numbers', folded: true, hero: ['tokens', 'cost', 'burn'], slots: ['turns', 'cost', 'cache'], chartBy: 'burn' })
    expect(migrateSpendPrefs({ v: 6, view: 'chart' })).toEqual({ v: 6, view: 'chart' })
  })

  it('keeps a version 3 choice as picked, its chart reading as cost', () => {
    const v3 = { v: 3, view: 'numbers', folded: true, hero: ['cost', 'burn', 'tokens'] }
    expect(migrateSpendPrefs(v3)).toEqual(v3)
    expect(normalizeSpendPrefs(migrateSpendPrefs(v3))).toMatchObject({ view: 'numbers', folded: true, hero: ['cost', 'burn', 'tokens'], chartBy: 'cost' })
    expect(normalizeSpendPrefs({ chartBy: 'tokens' }).chartBy).toBe('tokens')
    expect(normalizeSpendPrefs({ chartBy: 'turns' }).chartBy).toBe('turns')
    expect(normalizeSpendPrefs({ chartBy: 'burn' }).chartBy).toBe('burn')
    // A metric the chart does not draw, and 0.111.0's boolean `chart`, read as cost.
    expect(normalizeSpendPrefs({ chartBy: 'cache' }).chartBy).toBe('cost')
    expect(normalizeSpendPrefs({ chartBy: 'time', chart: true }).chartBy).toBe('cost')
  })

  it('brings a version 4 choice to 5 untouched, and runs each older step only for older versions', () => {
    // 5 only added burn rate to the menu: a version 4 choice was picked from
    // cost, tokens and turns and stays exactly as it was.
    const v4 = { v: 4, view: 'chart', folded: true, chartBy: 'turns', hero: ['cost', 'burn', 'tokens'] }
    expect(migrateSpendPrefs(v4)).toEqual(v4)
    expect(normalizeSpendPrefs(migrateSpendPrefs(v4))).toMatchObject({ view: 'chart', folded: true, chartBy: 'turns', hero: ['cost', 'burn', 'tokens'] })
    // The pre-3 hero step does not touch a version 4 hero that happens to be the old default.
    expect(normalizeSpendPrefs(migrateSpendPrefs(v4)).hero).toEqual(['cost', 'burn', 'tokens'])
    // A version 5 choice is current: the very object comes back.
    const v5 = { v: 5, view: 'numbers', chartBy: 'burn' }
    expect(migrateSpendPrefs(v5)).toBe(v5)
    expect(normalizeSpendPrefs(migrateSpendPrefs(v5)).chartBy).toBe('burn')
    // Older steps still run for older choices.
    expect(migrateSpendPrefs({ v: 1, view: 'numbers', folded: true })).toMatchObject({ view: 'chart', folded: false })
    expect(migrateSpendPrefs({ v: 2, hero: ['cost', 'burn', 'tokens'] })).toMatchObject({ hero: ['burn', 'tokens', 'cost'] })
  })

  it('reads each bar by the chart’s metric, each in its own format', () => {
    const b = { start: 0, end: 1, cost: 2.5, tokens: 1_000, turns: 4 }
    expect(barValue('cost', b)).toBe(2.5)
    expect(barValue('tokens', b)).toBe(1_000)
    expect(barValue('turns', b)).toBe(4)
    // An older daemon's bar has cost only: the rest are unknown, not zero.
    expect(barValue('tokens', { start: 0, end: 1, cost: 1 })).toBeUndefined()
    expect(barValue('turns', { start: 0, end: 1, cost: 1 })).toBeUndefined()
    expect(chartValueText('tokens', 950_120)).toBe('950.1k')
    expect(chartValueText('cost', 12.4)).toBe('$12.40')
    expect(chartValueText('turns', 1204)).toBe('1,204')
    expect(chartValueText('tokens', undefined)).toBe('—')
  })

  it('puts the chart’s metric first among the folded figures and leaves out what the period lacks', () => {
    const f = { cost: 1320.49, tokens: 4.35e9, turns: 1204, timeMs: 3 * 3_600_000 }
    expect(foldedFigures('cost', f).map((x) => x.value)).toEqual(['$1,320.49', '4.35B', '1,204'])
    expect(foldedFigures('turns', f).map((x) => x.id)).toEqual(['turns', 'cost', 'tokens'])
    expect(foldedFigures('tokens', { cost: 2, turns: 3 }).map((x) => x.id)).toEqual(['cost', 'turns'])
  })

  it('takes the figures from the session, or from the range summary with its sparks as the chart', () => {
    const f: SpendFigures = { cost: 2, tokens: 1_000, cache: 80, last: 0.25 }
    expect(rangeFigures(undefined)).toEqual({})
    const sum = {
      cost_usd: 9, tokens_in: 10, cache_read: 30, cache_write: 0, turns: 7, tool_calls: 21, savings: { hit_rate: 0.75 },
      projects: [{ spark: { from_ms: 1_000, width_ms: H, cost: [1, 0, 2] } }, { spark: { from_ms: 1_000, width_ms: H, cost: [0, 4] } }, {}],
    } as unknown as Summary
    const pf = rangeFigures(sum)
    expect(pf).toMatchObject({ cost: 9, tokens: 40, cache: 75, turns: 7, tools: 21 })
    expect(pf.series?.step).toBe(H)
    expect(pf.series?.bars).toEqual([
      { start: 1_000, end: 1_000 + H, cost: 1 },
      { start: 1_000 + H, end: 1_000 + 2 * H, cost: 4 },
      { start: 1_000 + 2 * H, end: 1_000 + 3 * H, cost: 2 },
    ])
    // A daemon that sends input and turns per bucket: summed alike.
    const full = {
      ...sum,
      projects: [
        { spark: { from_ms: 1_000, width_ms: H, cost: [1, 0], tokens: [0, 0], input: [100, 0], turns: [2, 0] } },
        { spark: { from_ms: 1_000, width_ms: H, cost: [0, 4], tokens: [0, 0], input: [100, 50], turns: [1, 3] } },
      ],
    } as unknown as Summary
    expect(rangeFigures(full).series?.bars).toEqual([
      { start: 1_000, end: 1_000 + H, cost: 1, tokens: 200, turns: 3 },
      { start: 1_000 + H, end: 1_000 + 2 * H, cost: 4, tokens: 50, turns: 3 },
    ])
    // A session's own figure has no Caprock-wide value: a dash, never a zero.
    expect(metricValue('last', pf)).toBe('—')
    expect(metricValue('last', f)).toBe('$0.25')
    // No spark in the summary: no series, rather than an empty line.
    expect(rangeFigures({ ...sum, projects: [] } as Summary).series).toBeUndefined()
    // The label says whose and when, both, every time.
    expect(spendLabel(WHOLE_SESSION)).toBe('Whole session')
    expect(spendLabel({ scope: 'session', window: 'today' })).toBe('Today · this session')
    expect(spendLabel({ scope: 'session', window: '7d' })).toBe('7 days · this session')
    expect(spendLabel({ scope: 'all', window: '30d' })).toBe('30 days · all sessions')
    // All sessions has no whole span: it reads today.
    expect(spendLabel({ scope: 'all', window: 'whole' })).toBe('Today · all sessions')
    // The folded chip: whose figures they are, short enough for a 330px cockpit.
    expect(periodChip(WHOLE_SESSION)).toBe('session')
    expect(periodChip({ scope: 'session', window: '7d' })).toBe('7d · session')
    expect(periodChip({ scope: 'all', window: 'today' })).toBe('today · all')
    expect(periodChip({ scope: 'all', window: '30d' })).toBe('30d · all')
  })
})

describe('burn rate on the chart', () => {
  const bar = (p: Partial<SpendBar>): SpendBar => ({ start: 0, end: H, cost: 0, ...p })

  it('is a bar’s active hours’ cost over those hours, and no value at all for a bar with none', () => {
    // A day with $13 spent but one active hour of $5: $5/h, not $13 over 24 hours.
    expect(barValue('burn', bar({ cost: 13, activeHours: 1, activeCost: 5 }))).toBe(5)
    expect(barValue('burn', bar({ cost: 9, activeHours: 2, activeCost: 9 }))).toBe(4.5)
    expect(barValue('burn', bar({ cost: 4, activeHours: 0, activeCost: 0 }))).toBeUndefined()
    expect(barValue('burn', bar({ cost: 4 }))).toBeUndefined()
    expect(barCarries('burn', bar({ activeHours: 0, activeCost: 0 }))).toBe(true)
    expect(barCarries('burn', bar({ cost: 4 }))).toBe(false)
    expect(chartValueText('burn', 3)).toBe('$3.00/h')
    expect(chartValueText('burn', undefined)).toBe('—')
  })

  it('totals the period as every active hour’s cost over every active hour, read from the summary’s sparks', () => {
    const sum = {
      range: '7d', cost_usd: 22, tokens_in: 0, cache_read: 0, cache_write: 0, turns: 40, tool_calls: 0, savings: { hit_rate: 0 },
      projects: [
        { project: 'a', tokens: 0, cost_usd: 13, sessions: 1, spark: { from_ms: 0, width_ms: 24 * H, cost: [13, 0], tokens: [0, 0], input: [0, 0], turns: [7, 0], active_hours: [1, 0], active_cost: [5, 0] } },
        { project: 'b', tokens: 0, cost_usd: 9, sessions: 2, spark: { from_ms: 0, width_ms: 24 * H, cost: [0, 9], tokens: [0, 0], input: [0, 0], turns: [0, 12], active_hours: [0, 2], active_cost: [0, 9] } },
      ],
    } as unknown as Summary
    const pf = rangeFigures(sum)
    expect(pf.series!.bars.map((b) => [b.activeHours, b.activeCost])).toEqual([[1, 5], [2, 9]])
    expect(periodBurn(pf.series!.bars)).toBeCloseTo(14 / 3)
    expect(chartTotal('burn', pf)).toBeCloseTo(14 / 3)
    // The session's own, when its bars are too fine to carry hours.
    expect(chartTotal('burn', { activeBurn: 2.5 })).toBe(2.5)
    // An older daemon sends no active hours: no burn, never $0/h.
    const old = rangeFigures({ ...sum, projects: sum.projects!.map((p) => ({ ...p, spark: { ...p.spark!, active_hours: undefined, active_cost: undefined } })) } as Summary)
    expect(old.series!.bars[0]!.activeHours).toBeUndefined()
    expect(chartTotal('burn', old)).toBeUndefined()
  })

  it('leads the folded strip with the chart’s own burn rate', () => {
    const pf = { cost: 22, tokens: 1000, turns: 40, series: { step: H, bars: [bar({ activeHours: 2, activeCost: 6 })] } }
    expect(foldedFigures('burn', pf).map((x) => [x.id, x.value])).toEqual([['burn', '$3.00/h'], ['cost', '$22.00'], ['tokens', '1,000']])
  })
})

describe('the scope and period of each tab', () => {
  it('opens every tab on its whole session, and keeps each pick to the tab it was made in', () => {
    resetSpendPrefsForTest()
    expect(getSpendPick('a')).toBe(WHOLE_SESSION)
    setSpendScope('a', 'all')
    // All sessions has no whole span: the tab draws today, and its window is kept as picked.
    expect(getSpendPick('a')).toEqual({ scope: 'all', window: 'whole' })
    expect(shownPick(getSpendPick('a'))).toEqual({ scope: 'all', window: 'today' })
    setSpendWindow('a', '30d')
    expect(getSpendPick('a')).toEqual({ scope: 'all', window: '30d' })
    // The other tabs keep theirs, both choices.
    expect(getSpendPick('b')).toBe(WHOLE_SESSION)
    setSpendWindow('b', '7d')
    expect(getSpendPick('b')).toEqual({ scope: 'session', window: '7d' })
    expect(getSpendPick('a')).toEqual({ scope: 'all', window: '30d' })
    // Switching scope keeps the window: this session over the same 30 days.
    setSpendScope('a', 'session')
    expect(getSpendPick('a')).toEqual({ scope: 'session', window: '30d' })
    // Whole is the session's alone.
    setSpendScope('a', 'all')
    setSpendWindow('a', 'whole')
    expect(getSpendPick('a')).toEqual({ scope: 'all', window: '30d' })
    // A tab back on the whole session after a trip to all sessions.
    setSpendScope('c', 'all')
    setSpendScope('c', 'session')
    expect(getSpendPick('c')).toBe(WHOLE_SESSION)
    // Not stored: nothing of it reaches the viewer's saved choices.
    expect(localStorage.getItem('caprock.app.cockpit.spend') ?? '').not.toMatch(/period|scope|window/)
    resetSpendPrefsForTest()
    expect(getSpendPick('b')).toBe(WHOLE_SESSION)
  })
})

describe('a window of this session', () => {
  const now = new Date(2026, 10, 19, 15, 30).getTime()
  const tok = (inp: number, read: number) => ({ in: inp, out: 10, cache_read: read, cache_write: 0 })

  it('starts at local midnight, like the daemon’s ranges', () => {
    expect(windowStart('today', now)).toBe(new Date(2026, 10, 19).getTime())
    expect(windowStart('7d', now)).toBe(new Date(2026, 10, 13).getTime())
    expect(windowStart('30d', now)).toBe(new Date(2026, 9, 21).getTime())
  })

  it('sums only the calls inside it', () => {
    const today = windowStart('today', now)
    const calls: CallPoint[] = [
      { id: 1, ts: today - H, cost: 5, tokens: tok(100, 900) },
      { id: 2, ts: today + 9 * H, cost: 1, tokens: tok(100, 300) },
      { id: 3, ts: today + 9 * H + 600_000, cost: 0.5, tokens: tok(0, 600) },
    ]
    const f = windowFigures(calls, today, now)
    expect(f.empty).toBeUndefined()
    expect(f).toMatchObject({ cost: 1.5, tokens: 1_000, turns: 2, timeMs: 600_000, last: 0.5 })
    expect(f.cache).toBeCloseTo(90)
    expect(f.burn?.perHour).toBeCloseTo(1.5 / (10 / 60))
    // Its tool calls are not carried by every call: a dash.
    expect(metricValue('tools', f)).toBe('—')
    // The 7 days hold the call before midnight too.
    expect(windowFigures(calls, windowStart('7d', now), now).cost).toBe(6.5)
    expect(metricTitle('cost', f, { scope: 'session', window: 'today' })).toBe('What the session spent today, at API list price')
  })

  it('is empty, not zeros, when the session made no call in it', () => {
    const f = windowFigures([{ id: 1, ts: windowStart('7d', now) - H, cost: 3 }], windowStart('7d', now), now)
    expect(f).toEqual({ empty: true })
    expect(metricValue('cost', f)).toBe('—')
  })
})

describe('the numbers row in a narrow cockpit', () => {
  it('draws a big figure with k, M or B and two decimals, the rest as before', () => {
    const f = { cost: 7924.31, tokens: 13_710_000_000, turns: 182_050, tools: 999, last: 412.3 }
    expect(metricValue('cost', f, true)).toBe('$7.92k')
    expect(metricValue('tokens', f, true)).toBe('13.71B')
    expect(metricValue('turns', f, true)).toBe('182.05k')
    expect(metricValue('tools', f, true)).toBe('999')
    expect(metricValue('last', f, true)).toBe('$412.30')
    expect(metricValue('cost', { cost: 1_250_000 }, true)).toBe('$1.25M')
    expect(metricValue('cost', { cost: 7924.31, unpriced: 1 }, true)).toBe('$7.92k+')
    // Without compact, the exact figure, as everywhere else.
    expect(metricValue('cost', f)).toBe('$7,924.31')
  })
})

describe('a cost with unpriced turns', () => {
  it('is a dash when nothing was priced, a lower bound with + when some was', () => {
    const unknown = { cost: 0, unpriced: 3, unpricedModels: ['kimi-k3'] }
    expect(costNote(unknown)?.state).toBe('unknown')
    expect(metricValue('cost', unknown)).toBe('—')
    expect(chartTotal('cost', unknown)).toBeUndefined()
    expect(metricTitle('cost', unknown)).toContain('No price for kimi-k3')
    expect(foldedFigures('cost', { ...unknown, tokens: 10 }).map((f) => f.id)).toEqual(['tokens'])
    const partial = { cost: 2.5, unpriced: 1, unpricedModels: ['kimi-k3'] }
    expect(metricValue('cost', partial)).toBe('$2.50+')
    expect(costNote(partial)?.title).toContain('1 turn on kimi-k3')
    expect(foldedFigures('cost', partial)[0]).toMatchObject({ id: 'cost', value: '$2.50+' })
    expect(metricValue('cost', { cost: 2.5 })).toBe('$2.50')
    expect(costNote({ cost: 0 })).toBeUndefined()
  })

  it('reads the session’s unpriced turns and, with no named model, its own', () => {
    const s = { session_id: 's', model: 'kimi-k3', started_at: 0, last_event_at: 0, stats: { session_id: 's', turns: 2, tool_calls: 0, files_touched: 0, tokens_in: 1, tokens_out: 1, cache_read: 0, cache_write: 0, cost_usd: 0, unpriced_turns: 2 } } as unknown as SessionSummary
    expect(spendFigures(s, [])).toMatchObject({ unpriced: 2, unpricedModels: ['kimi-k3'] })
    expect(spendFigures({ ...s, stats: { ...s.stats, unpriced_turns: undefined } }, []).unpriced).toBeUndefined()
  })

  it('counts a period’s unpriced turns from its summary', () => {
    const sum = { tokens_in: 0, cache_read: 0, cache_write: 0, cost_usd: 4, turns: 3, tool_calls: 0, projects: [], unpriced: { turns: 2, tokens: 9, models: ['deepseek-v9'] } } as unknown as Summary
    expect(metricValue('cost', rangeFigures(sum))).toBe('$4.00+')
  })
})
