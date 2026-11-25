import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/lib/api'

const m = vi.hoisted(() => ({
  settings: vi.fn(async () => ({ update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0 } as Record<string, unknown>)),
  save: vi.fn(async () => ({})),
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, settings: m.settings, saveSettings: m.save } }
})

import { ApiErrorStrip } from './ApiErrorStrip'
import { ApiErrorSetting } from './ApiErrorSetting'
import { apiErrorNotice, RECOVERED_SHOWN_MS } from '@/lib/apiError'
import { clearShared } from '@/lib/refresh'

const NOW = new Date('2026-11-25T10:00:00').getTime()

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: 's1', cwd: '/w/app', status: 'idle', owned: true, agent: 'claude',
    api_error: { at: NOW - 120_000, reason: '529 Overloaded', retryable: true, tries: 1, resume: 'resumed', resumed_at: NOW - 60_000 },
    ...over,
  } as SessionSummary
}

beforeEach(() => {
  clearShared()
  m.save.mockClear()
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW })
})
afterEach(() => { vi.useRealTimers() })

describe('apiErrorNotice', () => {
  it('says each try, the recovery for an hour, and the give-up', () => {
    expect(apiErrorNotice(session(), NOW)).toEqual({ kind: 'resumed', text: 'API error (529 Overloaded) — resumed automatically · try 1 of 3' })
    const recovered = session({ api_error: { tries: 2, resume: 'recovered', resumed_at: NOW - 60_000 } })
    expect(apiErrorNotice(recovered, NOW)?.text).toBe('API error — resumed automatically (try 2 of 3) · it went on')
    expect(apiErrorNotice(recovered, NOW + RECOVERED_SHOWN_MS)).toBeNull()
    const gaveUp = session({ api_error: { at: NOW - 1000, reason: '500 Internal server error', retryable: true, tries: 3, resume: 'gave_up', resumed_at: NOW - 900_000 } })
    expect(apiErrorNotice(gaveUp, NOW)).toEqual({ kind: 'gave_up', text: 'API error (500 Internal server error) — gave up after 3 automatic tries' })
  })

  it('says nothing Caprock did not do, nor about a session that is not its own or has ended', () => {
    expect(apiErrorNotice(session({ api_error: { at: NOW, reason: 'Invalid API key', retryable: false } }), NOW)).toBeNull()
    expect(apiErrorNotice(session({ api_error: { at: NOW, retryable: true, tries: 0, resume: 'stopped' } }), NOW)).toBeNull()
    expect(apiErrorNotice(session({ owned: false }), NOW)).toBeNull()
    expect(apiErrorNotice(session({ status: 'ended' }), NOW)).toBeNull()
    expect(apiErrorNotice(session({ api_error: null }), NOW)).toBeNull()
    // A recovery with a newer error standing is a new incident.
    expect(apiErrorNotice(session({ api_error: { at: NOW, tries: 1, resume: 'recovered', resumed_at: NOW - 1000 } }), NOW)).toBeNull()
  })
})

describe('the API-error line', () => {
  it('shows the try under the terminal and hides on a click', () => {
    render(<ApiErrorStrip session={session()} />)
    const strip = screen.getByRole('status', { name: 'API error' })
    expect(strip).toHaveTextContent('API error (529 Overloaded) — resumed automatically · try 1 of 3')
    expect(strip).toHaveAttribute('data-api-error-strip', 'resumed')
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByRole('status', { name: 'API error' })).toBeNull()
  })

  it('shows the give-up, and nothing for an error it does not answer', () => {
    const { rerender } = render(<ApiErrorStrip session={session({ api_error: { at: NOW, reason: '529 Overloaded', retryable: true, tries: 3, resume: 'gave_up' } })} />)
    expect(screen.getByRole('status', { name: 'API error' })).toHaveTextContent('gave up after 3 automatic tries')
    rerender(<ApiErrorStrip session={session({ api_error: { at: NOW, reason: 'Prompt is too long', retryable: false } })} />)
    expect(screen.queryByRole('status', { name: 'API error' })).toBeNull()
  })
})

describe('Settings → After an API error', () => {
  it('is on by default and saves the switch', async () => {
    render(<ApiErrorSetting />)
    const box = await screen.findByRole('checkbox', { name: /Resume after API errors/ })
    expect(box).toBeChecked()
    fireEvent.click(box)
    await waitFor(() => expect(m.save).toHaveBeenCalledWith({ resume_after_api_error: false }))
    expect(box).not.toBeChecked()
  })

  it('shows a saved off', async () => {
    m.settings.mockResolvedValueOnce({ update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0, resume_after_api_error: false })
    render(<ApiErrorSetting />)
    expect(await screen.findByRole('checkbox', { name: /Resume after API errors/ })).not.toBeChecked()
  })
})
