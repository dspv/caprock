import { describe, expect, it } from 'vitest'
import { atRate, overheadCell, overheadRows, samplesCount } from './CursorSpend'
import { overheadSentence } from './CursorOverhead'
import type { OverheadReport, SessionOverhead } from '@/lib/api'

const report: OverheadReport = {
  range: '30d',
  cursor: [
    { family: 'claude-sonnet-4', models: ['claude-4-sonnet'], samples: 14, clean: 7, median_tokens: 88458, min_tokens: 13395 },
    { family: 'composer-1', models: ['composer-1'], samples: 9, clean: 0, median_tokens: 0, min_tokens: 0 },
  ],
  claude: [
    { family: 'claude-sonnet-4', models: ['claude-sonnet-4-20250514'], samples: 30, clean: 30, median_tokens: 21000, min_tokens: 18000 },
    { family: 'claude-opus-5-5', models: ['claude-opus-5-5'], samples: 8278, clean: 8278, median_tokens: 30848, min_tokens: 22255 },
  ],
  rates: [{ family: 'claude-sonnet-4', model: 'claude-sonnet-4', input: 3, cache_read: 0.3 }],
  method: 'how',
}

describe('Cursor overhead comparison', () => {
  it('puts one model from both agents on one row, Cursor first', () => {
    const rows = overheadRows(report)
    expect(rows[0]!.family).toBe('claude-sonnet-4')
    expect(rows[0]!.cursor?.median_tokens).toBe(88458)
    expect(rows[0]!.claude?.median_tokens).toBe(21000)
    expect(rows[0]!.input).toBe(3)
    // A family with no clean Cursor sample and no Claude Code one is dropped.
    expect(rows.find((r) => r.family === 'composer-1')).toBeUndefined()
    // Claude Code alone still shows, for the comparison.
    expect(rows.find((r) => r.family === 'claude-opus-5-5')?.claude?.samples).toBe(8278)
  })

  it('says how many samples stand behind a median, and a dash for none', () => {
    expect(overheadCell(report.cursor[1])).toBe('—')
    expect(samplesCount(report.cursor[0])).toBe('7 of 14')
    expect(samplesCount(report.claude[0])).toBe('30')
    expect(samplesCount({ ...report.cursor[0]!, samples: 8407, clean: 8407 })).toBe('8,407')
  })

  it('prices a token count at a list rate per million', () => {
    expect(atRate(1_000_000, 3)).toBe(3)
    expect(atRate(88458, 0.3)).toBeCloseTo(0.0265, 4)
  })
})

describe('one chat’s overhead', () => {
  const o: SessionOverhead = {
    model: 'composer-1', request_tokens: 19330, typed_tokens: 10, visible_tokens: 1200, overhead_tokens: 18130,
    model_calls: 6, clean: true, family: 'composer-1', method: 'how',
    cursor_family: { family: 'composer-1', models: ['composer-1'], samples: 9, clean: 3, median_tokens: 17000, min_tokens: 15000 },
  }
  it('names the request, the part that was not the conversation, and what it was read from', () => {
    const s = overheadSentence(o)
    expect(s.lead).toContain('19.3k')
    expect(s.parts.join(' ')).toContain('6 model calls')
    expect(s.compare).toContain('over 3 chats')
    expect(s.compare).not.toContain('Claude Code')
  })
})
