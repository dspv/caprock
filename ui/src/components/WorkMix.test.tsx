/**
 * The work-kind panel. Two things here are claims rather than layout, and both
 * are what these tests pin: the labels must not flatter (a turn that called no
 * tool is called that, never "conversation" or "thinking"), and a linkage the
 * daemon could not complete must be visible rather than silently inflating the
 * "no tool call" row into a finding (rule 6).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WorkMix } from './WorkMix'
import type { Summary, WorkShare } from '@/lib/api'

const work = (over: Partial<WorkShare>): WorkShare => ({
  kind: 'edit', turns: 1, tokens: 100, cost_usd: 1, tokens_pct: 10, cost_pct: 10, ...over,
})

const summary = (over: Partial<Summary>): Summary => ({
  range: '30d', from_ms: 0, sessions: 1, active_sessions: 0, turns: 10, tool_calls: 1000,
  tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 10,
  models: [], projects: [], work: [], work_unlinked_calls: 0,
  savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 },
  burn: { window_min: 10, usd_per_hour: 0, tokens_per_min: 0, turns: 0 },
  pricing_version: 'x', throttles: 0,
  ...over,
})

describe('WorkMix', () => {
  it('names a turn that called no tool for what it is, never "conversation"', () => {
    // The whole panel turns on this label. A turn that called nothing may have
    // been reasoning, planning, or answering a question; naming it any one of
    // those asserts something the capture does not record.
    render(<WorkMix summary={summary({ work: [work({ kind: 'none', cost_usd: 8, cost_pct: 80 })] })} />)
    expect(screen.getByText('no tool call')).toBeTruthy()
    for (const flattering of ['conversation', 'thinking', 'planning', 'reasoning']) {
      expect(screen.queryByText(new RegExp(`^${flattering}$`, 'i'))).toBeNull()
    }
  })

  it('shows every kind with its own label and its share of cost', () => {
    render(
      <WorkMix
        summary={summary({
          work: [
            work({ kind: 'edit', cost_usd: 5, cost_pct: 50 }),
            work({ kind: 'command', cost_usd: 3, cost_pct: 30 }),
            work({ kind: 'read', cost_usd: 2, cost_pct: 20 }),
          ],
        })}
      />,
    )
    expect(screen.getByText('writing code')).toBeTruthy()
    expect(screen.getByText('running commands')).toBeTruthy()
    expect(screen.getByText('reading and searching')).toBeTruthy()
    expect(screen.getByText('50%')).toBeTruthy()
  })

  it('warns when tool calls could not be matched to their turns', () => {
    // An unlinked call leaves its turn looking as though it called nothing, so
    // the "no tool call" row is overstated by an unknown amount. Publishing the
    // breakdown without saying so would publish a number we know may be wrong.
    render(<WorkMix summary={summary({ tool_calls: 1000, work_unlinked_calls: 400, work: [work({})] })} />)
    expect(screen.getByText(/could not be matched/i)).toBeTruthy()
  })

  it('stays quiet when the linkage is essentially complete', () => {
    // A handful of unlinked calls out of thousands cannot move a row enough to
    // matter, and a warning nobody can act on is noise that devalues the ones
    // that count.
    render(<WorkMix summary={summary({ tool_calls: 1000, work_unlinked_calls: 2, work: [work({})] })} />)
    expect(screen.queryByText(/could not be matched/i)).toBeNull()
  })

  it('says nothing was measured rather than rendering an empty table', () => {
    render(<WorkMix summary={summary({ work: [] })} />)
    expect(screen.getByText(/no priced turns in range/i)).toBeTruthy()
  })
})
