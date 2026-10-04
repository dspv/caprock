import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ToolDrill as Drill } from '@/lib/api'
import { ToolDrill } from './ToolDrill'

const data = vi.hoisted(() => ({
  value: undefined as unknown,
  pricing: {
    yearly: { per_month_usd: 2.5, charged_usd: 30, period: 'year', url: 'https://example.test/yearly' },
    monthly: { per_month_usd: 5, charged_usd: 5, period: 'month', url: 'https://example.test/monthly' },
    lifetime: { per_month_usd: 0, charged_usd: 100, period: 'once', url: 'https://example.test/lifetime' },
    info_url: 'https://example.test/premium/',
  },
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, toolDrill: async () => data.value, premium: async () => data.pricing } }
})

const free: Drill = {
  tool: 'Bash', kind: 'shell', group_by: 'command', calls: 700, other: 30, range: 'all', locked: true,
  rows: [{ key: 'git status', calls: 400 }, { key: 'go test', calls: 270 }],
  teaser: { kind: 'output', key: 'git diff', text: '`git diff` returned 12.4 MB in 300 calls — 41% of everything Bash returned to the model.' },
}

describe('the tool drill-down', () => {
  it('shows the groups free, the strongest hint in full, and no Premium figure', async () => {
    data.value = free
    render(<ToolDrill tool="Bash" range="all" />)
    expect(await screen.findByText('git status')).toBeTruthy()
    expect(screen.getByText('57%')).toBeTruthy() // 400 of 700, floored
    expect(document.body.textContent).toContain('41% of everything Bash returned')
    // Placeholders under glass, never a number that could be read as measured.
    expect(document.body.textContent).not.toMatch(/\d+(\.\d+)? ?(KB|MB|GB)\b(?![\s\S]*41% of everything)/)
    fireEvent.click(screen.getByRole('button', { name: /^premium$/i }))
    expect(await screen.findByText(/What each tool returned, and where it failed/)).toBeTruthy()
  })

  it('shows output, failure rate and trend with a licence', async () => {
    data.value = {
      ...free, locked: false, teaser: undefined, results: 690, failures: 40, bytes: 2_000_000,
      rows: [
        { key: 'git status', calls: 400, results: 400, failures: 0, bytes: 100_000, trend: [1, 2, 3, 4, 5, 6, 7, 8] },
        { key: 'go test', calls: 270, results: 260, failures: 39, bytes: 900_000, trend: [8, 7, 6, 5, 4, 3, 2, 1] },
      ],
      hints: [{ kind: 'failures', key: 'go test', text: '`go test` failed 39 of 260 times (15%), against 6% for Bash overall.' }],
    }
    render(<ToolDrill tool="Bash" range="all" />)
    expect(await screen.findByText('15%')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^premium$/i })).toBeNull()
    expect(document.body.textContent).toContain('failed 39 of 260 times')
  })
})
