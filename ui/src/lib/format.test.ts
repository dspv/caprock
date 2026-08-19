import { describe, expect, it } from 'vitest'
import { basename, fmtAgo, fmtPct, fmtTokens, fmtUSD, shortId, fmtTool } from './format'

describe('format', () => {
  it('formats USD with more precision for tiny amounts', () => {
    expect(fmtUSD(12.3456)).toBe('$12.35')
    expect(fmtUSD(0.0042)).toBe('$0.0042')
    expect(fmtUSD(0)).toBe('$0.00')
    expect(fmtUSD(undefined)).toBe('—')
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
