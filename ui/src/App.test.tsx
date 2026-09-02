import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

const summary = {
  range: 'today', sessions: 0, active_sessions: 0, turns: 0, tool_calls: 0,
  tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0,
  models: [], projects: [],
  savings: { hit_rate: 0, cut_pct: 0, saved: 0, billed_with: 0, billed_without: 0 },
  burn: { window_min: 10, usd_per_hour: 0, tokens_per_min: 0, turns: 0 },
  pricing_version: 't',
}

function stubApi(status = 200) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    // The daemon refuses every /v1 path to an unpaired device, and serves the
    // app's own files to anyone — which is what makes a pairing page possible.
    if (status !== 200) {
      return new Response(JSON.stringify({ error: 'this device is not paired with Caprock' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const body = url.includes('/v1/sessions')
      ? []
      : url.includes('/v1/stats/summary')
        ? summary
        : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}

describe('App', () => {
  it('renders the shell and the Now screen', async () => {
    stubApi()
    render(<App />)
    expect(await screen.findByText('caprock')).toBeInTheDocument()
    expect(await screen.findByText('No sessions yet')).toBeInTheDocument()
  })

  // A tablet reaching the machine over the network gets the pairing page, not
  // a dashboard of em-dashes with an error in the corner. Nothing behind it
  // works until a code has been traded for a token, and a page of empty panels
  // invites someone to dismiss the prompt and conclude the product is broken.
  it('asks an unpaired device for a code instead of showing empty panels', async () => {
    stubApi(401)
    render(<App />)
    expect(await screen.findByText('Pair this device')).toBeInTheDocument()
    expect(screen.queryByText('No sessions yet')).not.toBeInTheDocument()
  })

  // A daemon that is down is a different problem, and the screens already say
  // so. Showing a pairing form would send someone hunting for a code that
  // could not have helped.
  it('does not ask for a code when the daemon is simply unreachable', async () => {
    stubApi(500)
    render(<App />)
    expect(await screen.findByText('caprock')).toBeInTheDocument()
    expect(screen.queryByText('Pair this device')).not.toBeInTheDocument()
  })
})
