import { describe, expect, it } from 'vitest'
import { basename, fmtAgo, fmtCountCompact, fmtCountShort, fmtPct, fmtTokens, fmtUSD, fmtUSDCompact, fmtUSDk, fmtUSDShort, shortId, fmtTool } from './format'

describe('format', () => {
  it('formats USD with more precision for tiny amounts', () => {
    expect(fmtUSD(12.3456)).toBe('$12.35')
    expect(fmtUSD(0.0042)).toBe('$0.0042')
    expect(fmtUSD(0)).toBe('$0.00')
    expect(fmtUSD(undefined)).toBe('—')
  })
  it('shortens a count for a tight row', () => {
    expect(fmtCountShort(781)).toBe('781')
    expect(fmtCountShort(7781)).toBe('7.8k')
    expect(fmtCountShort(35244)).toBe('35.2k')
    expect(fmtCountShort(2000)).toBe('2k')
    expect(fmtCountShort(999_999)).toBe('1M')
    expect(fmtCountShort(1_250_000)).toBe('1.3M')
    expect(fmtCountShort(undefined)).toBe('—')
  })
  it('formats tokens compactly', () => {
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(12_345)).toBe('12.3k')
    expect(fmtTokens(2_500_000)).toBe('2.50M')
    expect(fmtTokens(null)).toBe('—')
  })
  it('formats percentages and ages', () => {
    expect(fmtPct(47.0195)).toBe('47%')
    expect(fmtPct(3.14159, 1)).toBe('3.1%')
    const now = Date.parse('2026-08-18T12:00:00Z')
    expect(fmtAgo('2026-08-18T11:59:58Z', now)).toBe('now')
    expect(fmtAgo('2026-08-18T11:59:00Z', now)).toBe('1m ago')
    expect(fmtAgo('2026-08-18T11:00:00Z', now)).toBe('1h ago')
    expect(fmtAgo(undefined, now)).toBe('—')
  })
  it('shortens ids and paths on both separators', () => {
    expect(shortId('8e968de8-d2a4-428f')).toBe('8e968de8')
    expect(basename('/a/b/c.go')).toBe('c.go')
    expect(basename('C:\\x\\y.go')).toBe('y.go')
  })
  it('shortens mcp tool names, passes plain ones through', () => {
    expect(fmtTool('mcp__claude-in-chrome__tabs_context_mcp')).toBe('claude-in-chrome·tabs_context_mcp')
    expect(fmtTool('Bash')).toBe('Bash')
    expect(fmtTool('mcp__apify__call-actor')).toBe('apify·call-actor')
  })
})

describe('short dollar figures', () => {
  it('drops cents on a headline and shortens thousands', () => {
    expect(fmtUSDShort(16817.45)).toBe('$16.8k')
    expect(fmtUSDShort(1234)).toBe('$1.2k')
    expect(fmtUSDShort(12000)).toBe('$12k')
    expect(fmtUSDShort(168_400)).toBe('$168k')
    expect(fmtUSDShort(1_240_000)).toBe('$1.2M')
    expect(fmtUSDShort(158.66)).toBe('$159')
    expect(fmtUSDShort(0.42)).toBe('$0.42')
  })
  it('keeps three decimals of thousands for a panel total', () => {
    expect(fmtUSDk(16817.53)).toBe('$16.818k')
    expect(fmtUSDk(1234)).toBe('$1.234k')
    expect(fmtUSDk(512.3)).toBe('$512.30')
  })
})

describe('compact figures for a narrow cell', () => {
  it('keeps dollars below $1,000 as they are, then k, M and B with two decimals', () => {
    expect(fmtUSDCompact(412.3)).toBe('$412.30')
    expect(fmtUSDCompact(999)).toBe('$999.00')
    expect(fmtUSDCompact(0.004)).toBe('$0.0040')
    expect(fmtUSDCompact(7924.31)).toBe('$7.92k')
    expect(fmtUSDCompact(1_250_000)).toBe('$1.25M')
    expect(fmtUSDCompact(3_400_000_000)).toBe('$3.40B')
    expect(fmtUSDCompact(-7924.31)).toBe('-$7.92k')
    // 999,999 rounds to 1000.00k: it steps up to the next unit.
    expect(fmtUSDCompact(999_999)).toBe('$1.00M')
    expect(fmtUSDCompact(undefined)).toBe('—')
  })
  it('counts to 999 in full, then k, M and B with two decimals', () => {
    expect(fmtCountCompact(999)).toBe('999')
    expect(fmtCountCompact(182_050)).toBe('182.05k')
    expect(fmtCountCompact(13_710_000_000)).toBe('13.71B')
    expect(fmtCountCompact(1_250_000)).toBe('1.25M')
    expect(fmtCountCompact(NaN)).toBe('—')
  })
})
