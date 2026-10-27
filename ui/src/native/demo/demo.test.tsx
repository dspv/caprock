/**
 * The iOS app's demo mode (ADR-083): the dashboard runs on bundled sample
 * data through the same fetch and WebSocket it uses through the relay, reads
 * answer from the sample, and nothing that would change something goes
 * anywhere.
 */
import { act, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import App from '@/App'
import { api, errText } from '@/lib/api'
import { DEMO_MACHINE_NAME, DEMO_REFUSAL, installDemo } from '.'

let outside: ReturnType<typeof vi.fn>

beforeAll(() => {
  // What a request that is not for the daemon reaches: it must never be one of the dashboard's.
  outside = vi.fn(async () => new Response('', { status: 599 }))
  vi.stubGlobal('fetch', outside)
  installDemo()
  installDemo() // idempotent: a second call wraps nothing twice
})

describe('demo mode', () => {
  it('answers the dashboard from the sample', async () => {
    const res = await fetch('/v1/status')
    expect(res.status).toBe(200)
    expect((await res.json()).version).toBe('sample')
    expect((await api.pairMe()).role).toBe('controller')
    expect(DEMO_MACHINE_NAME).toBe('Sample Mac')
    const health = await fetch(`${location.origin}/healthz`)
    expect(health.ok).toBe(true)
    expect(outside).not.toHaveBeenCalled()
  })

  it('refuses every change with a line saying the demo sends nothing', async () => {
    const res = await fetch('/v1/inbox', { method: 'POST', body: '{}' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe(DEMO_REFUSAL)
    await expect(api.addInbox({ text: 'hello' }).catch((e) => errText(e))).resolves.toBe(DEMO_REFUSAL)
    expect(outside).not.toHaveBeenCalled()
  })

  it('answers what is not in the sample with 404, and passes other origins through', async () => {
    expect((await fetch('/v1/no-such-thing')).status).toBe(404)
    await fetch('https://example.com/v1/status')
    expect(outside).toHaveBeenCalledTimes(1)
  })

  it('opens the live feed and says hello', async () => {
    const ws = new WebSocket(`ws://${location.host}/v1/live`)
    const got = await new Promise<string>((resolve) => { ws.onmessage = (m) => resolve(String(m.data)) })
    expect(JSON.parse(got).type).toBe('hello')
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('draws the phone home on the sample, with nothing broken', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('max-width') || q.includes('coarse'), media: q, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }))
    localStorage.setItem('caprock.device.token', 'demo')
    location.hash = '#/'
    render(<App />)
    expect(await screen.findByRole('region', { name: 'Needs you' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getAllByText('Run the migration on a copy of the database first?').length).toBeGreaterThan(0)
    expect((await screen.findAllByText(/Tidy the shell aliases/, {}, { timeout: 5000 })).length).toBeGreaterThan(0)
    await act(async () => { await new Promise((r) => setTimeout(r, 300)) })
    expect(document.querySelector('[data-crash-screen]')).toBeNull()
    expect(screen.queryByText(/hit a snag/i)).toBeNull()
    expect(outside).not.toHaveBeenCalled() // every request the dashboard made was answered here
    // Continue mirrors the sample Mac's tabs, not a list still being read.
    expect(document.querySelector('[data-continue-source="tabs"]')).not.toBeNull()
  }, 15000)
})
