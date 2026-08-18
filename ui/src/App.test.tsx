import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

describe('App', () => {
  it('renders the shell and the Now screen', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = url.includes('/v1/sessions') ? [] : url.includes('/v1/stats/summary') ? { range: 'today', sessions: 0, active_sessions: 0, turns: 0, tool_calls: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0, models: [], projects: [], savings: { hit_rate: 0, cut_pct: 0, saved: 0, billed_with: 0, billed_without: 0 }, burn: { window_min: 10, usd_per_hour: 0, tokens_per_min: 0, turns: 0 }, pricing_version: 't' } : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    render(<App />)
    expect(screen.getByText('caprock')).toBeInTheDocument()
    expect(await screen.findByText('No sessions yet')).toBeInTheDocument()
  })
})
