import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ToolDrill as Drill } from '@/lib/api'
import { ToolDrill } from './ToolDrill'

const data = vi.hoisted(() => ({ value: undefined as unknown }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, toolDrill: async () => data.value } }
})

const drill: Drill = {
  tool: 'Bash', kind: 'shell', group_by: 'command', calls: 700, other: 30, range: 'all',
  results: 690, failures: 40, bytes: 2_000_000,
  rows: [
    { key: 'git status', calls: 400, results: 400, failures: 0, bytes: 100_000, trend: [1, 2, 3, 4, 5, 6, 7, 8] },
    { key: 'go test', calls: 270, results: 260, failures: 39, bytes: 900_000, trend: [8, 7, 6, 5, 4, 3, 2, 1] },
  ],
  hints: [{ kind: 'failures', key: 'go test', text: '`go test` failed 39 of 260 times (15%), against 6% for Bash overall.' }],
}

// The whole drill is free (2026-11-27, ADR-022 amended): no lock, no Premium.
describe('the tool drill-down', () => {
  it('shows the groups, output, failure rate, trend and hints, with nothing to buy', async () => {
    data.value = drill
    render(<ToolDrill tool="Bash" range="all" />)
    expect(await screen.findByText('15%')).toBeTruthy()
    expect(screen.getByText('57%')).toBeTruthy() // 400 of 700, floored
    expect(screen.queryByRole('button', { name: /premium/i })).toBeNull()
    expect(document.body.textContent).not.toMatch(/premium/i)
    expect(document.body.textContent).toContain('failed 39 of 260 times')
  })
})
