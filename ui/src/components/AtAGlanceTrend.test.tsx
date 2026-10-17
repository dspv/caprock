/**
 * The At a glance dynamics (owner, 2026-10-17, translated: "I only need the
 * rough dynamics, no graphs"): each legend row's change in share between the
 * last seven days and the seven before, and one sentence under the money
 * donut only when a model moved by five points or more.
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Donut, type Segment } from './Donut'
import { glanceCharts, glanceTrends, moneyStory, segmentTrends } from './AtAGlance'
import type { Glance, History } from '@/lib/api'

const models: Segment[] = [
  { key: 'opus5', label: 'Opus 5', value: 600, display: '$600' },
  { key: 'opus55', label: 'Opus 5.5', value: 300, display: '$300' },
  { key: '__other', label: 'other', value: 100, display: '$100' },
]

describe('segmentTrends', () => {
  it('gives each row its share in both windows, "other" as the rest', () => {
    const t = segmentTrends(models, { opus5: 70, opus55: 22, haiku: 8 }, { opus5: 38, opus55: 31, haiku: 31 }, 'spend', 7)!
    expect(Math.round(t.get('opus55')!.recent)).toBe(31)
    expect(Math.round(t.get('opus55')!.prior)).toBe(22)
    expect(Math.round(t.get('__other')!.recent)).toBe(31)
    expect(t.get('opus55')!.title).toBe('Opus 5.5: 31% of spend in the last 7 days, 22% in the 7 days before')
  })

  it('is no trend when either window holds nothing', () => {
    expect(segmentTrends(models, {}, { opus5: 1 }, 'spend', 7)).toBeUndefined()
    expect(segmentTrends(models, { opus5: 1 }, {}, 'spend', 7)).toBeUndefined()
  })
})

describe('moneyStory', () => {
  it('names the gainer and the loser when each moved five points or more', () => {
    const t = segmentTrends(models, { opus5: 70, opus55: 22, x: 8 }, { opus5: 38, opus55: 31, x: 31 }, 'spend', 7)
    expect(moneyStory(models, t, 7)).toBe("Opus 5.5 is gaining: 31% of the last 7 days' spend vs 22% the 7 before; Opus 5 fell to 38% from 70%.")
  })

  it('says nothing when no model moved five points', () => {
    const t = segmentTrends(models, { opus5: 60, opus55: 30, x: 10 }, { opus5: 58, opus55: 33, x: 9 }, 'spend', 7)
    expect(moneyStory(models, t, 7)).toBeUndefined()
  })
})

describe('the legend trend column', () => {
  it('draws up, down and flat markers, with the words in the hover', () => {
    const t = segmentTrends(models, { opus5: 70, opus55: 22, x: 8 }, { opus5: 38, opus55: 31, x: 31 }, 'spend', 7)
    const { container } = render(<Donut title="Where the money went" segments={models} center="60%" centerLabel="Opus 5" ariaLabel="m" trends={t} />)
    const marks = [...container.querySelectorAll('[data-trend]')]
    expect(marks.map((m) => m.getAttribute('data-trend'))).toEqual(['down', 'up', 'up'])
    expect(marks[1]!.textContent).toContain('↑ 9')
    expect(marks[1]!.getAttribute('title')).toContain('Opus 5.5: 31% of spend in the last 7 days')
    const flat = segmentTrends(models, { opus5: 60, opus55: 30, x: 10 }, { opus5: 60.2, opus55: 30, x: 9.8 }, 'spend', 7)
    const f = render(<Donut title="m" segments={models} center="" centerLabel="" ariaLabel="m" trends={flat} />)
    expect([...f.container.querySelectorAll('[data-trend]')].map((m) => m.textContent?.[0])).toEqual(['·', '·', '·'])
  })

  it('leaves the legend as it was without a trend', () => {
    const { container } = render(<Donut title="m" segments={models} center="" centerLabel="" ariaLabel="m" />)
    expect(container.querySelector('[data-trend]')).toBeNull()
    expect(container.querySelector('li')!.children).toHaveLength(4)
  })
})

describe('glanceTrends', () => {
  it('reads every block from the glance windows', () => {
    const h = {
      summary: { models: [{ model: 'm1', cost_usd: 10 }, { model: 'm2', cost_usd: 5 }] },
      tools: [{ tool: 'Bash', count: 10 }, { tool: 'Read', count: 5 }],
    } as unknown as History
    const w = (m1: number, m2: number, bash: number, read: number, claude: number, codex: number) => ({
      models: { m1, m2 },
      bill: { input_usd: 1, output_usd: 1, cache_write_usd: 1, cache_read_usd: m1 },
      tools: { Bash: bash, Read: read },
      agents: [
        { agent: 'claude', subagent: false, turns: 1, cost_usd: claude, sessions: 1 },
        { agent: 'codex', subagent: false, turns: 1, cost_usd: codex, sessions: 1 },
      ],
    })
    const g = {
      agents: [
        { agent: 'claude', subagent: false, turns: 2, cost_usd: 10, sessions: 1 },
        { agent: 'codex', subagent: false, turns: 2, cost_usd: 5, sessions: 1 },
      ],
      bill: { input_usd: 1, output_usd: 1, cache_write_usd: 1, cache_read_usd: 9 },
      display: {},
      trend: { days: 7, prior_from_ms: 0, cut_ms: 1, to_ms: 2, prior: w(9, 1, 9, 1, 9, 1), recent: w(5, 5, 5, 5, 5, 5) },
    } as Glance
    const c = glanceCharts(h, g)
    const tr = glanceTrends(c, [{ key: 'claude', who: 'claude', name: 'Claude Code', turns: 2, cost: 10 }, { key: 'codex', who: 'codex', name: 'Codex', turns: 2, cost: 5 }] as never, g)!
    expect(Math.round(tr.models!.get('m2')!.prior)).toBe(10)
    expect(Math.round(tr.models!.get('m2')!.recent)).toBe(50)
    expect(Math.round(tr.tools!.get('Read')!.recent)).toBe(50)
    expect(Math.round(tr.agents!.get('codex')!.recent)).toBe(50)
    expect(tr.bill!.get('cache_read')).toBeDefined()
    expect(tr.story).toMatch(/^m2 is gaining: 50% of the last 7 days' spend vs 10% the 7 before; m1 fell to 50% from 90%\.$/)
    expect(glanceTrends(c, [], { ...g, trend: undefined })).toBeUndefined()
  })
})
