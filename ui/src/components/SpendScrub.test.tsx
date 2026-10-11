import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Event } from '@/lib/api'

const now = Date.now()
const h = vi.hoisted(() => ({ series: [] as unknown[] }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, sessionCalls: async () => h.series } }
})

import { SpendOverTime } from './SpendScrub'

const ev = (id: number, ago: number, cost: number): Event => ({ id, ts: new Date(now - ago).toISOString(), session_id: 's1', source: 'transcript', kind: 'turn.assistant', payload: {}, cost_usd: cost } as Event)

describe('the spend by time', () => {
  it('says what the latest stretch cost and which tools, and moves with the arrow keys', async () => {
    h.series = [
      { id: 1, ts: now - 50 * 60_000, cost_usd: 2, tools: [{ tool: 'Bash' }] },
      { id: 2, ts: now - 2 * 60_000, cost_usd: 0.5, tools: [{ tool: 'Bash' }, { tool: 'Edit' }] },
      { id: 3, ts: now - 60_000, cost_usd: 0.25, tools: [{ tool: 'Bash' }] },
    ]
    await act(async () => { render(<SpendOverTime sessionId="s1" events={[ev(2, 2 * 60_000, 0.5), ev(3, 60_000, 0.25)]} now={now} />) })
    const box = screen.getByRole('group', { name: 'Spend by time' })
    expect(box.className).not.toMatch(/\b(absolute|fixed)\b/)
    const r = box.querySelector('[data-spend-readout]')!
    expect(r.textContent).toMatch(/Bash/)
    expect(r.textContent).toMatch(/call/)
    expect(box.textContent).toMatch(/peak .* \$2\.00/)
    const before = r.textContent
    fireEvent.keyDown(box, { code: 'ArrowLeft', key: 'ArrowLeft' })
    expect(box.querySelector('[data-spend-readout]')!.textContent).not.toBe(before)
  })
})
