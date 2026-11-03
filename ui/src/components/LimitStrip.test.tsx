import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContinueOnResult, SessionSummary, Subscription, SubscriptionsResponse } from '@/lib/api'

function sub(over: Partial<Subscription>): Subscription {
  return {
    id: 'default', agent: 'claude', label: 'Own sign-in', default: true, dir: '/h/.claude', signed_in: true, login_command: 'claude auth login',
    windows: [], sessions_7d: 0, cost_7d_usd: 0, running: 0, ...over,
  }
}

function response(claude: Subscription[], codex: { installed: boolean; signedIn: boolean } = { installed: false, signedIn: false }): SubscriptionsResponse {
  return {
    agents: [
      { agent: 'claude', label: 'Claude Code', installed: true, subscriptions: claude },
      { agent: 'codex', label: 'Codex', installed: codex.installed, subscriptions: [sub({ agent: 'codex', dir: '/h/.codex', signed_in: codex.signedIn })] },
    ],
    licensed: false, free_per_agent: 3, home: '/h',
  }
}

const deepseek = sub({ id: 'deepseek', label: 'DeepSeek', default: false, dir: '', provider: 'deepseek' })
const kimi = sub({ id: 'kimi', label: 'Kimi', default: false, dir: '', provider: 'kimi' })

const m = vi.hoisted(() => ({
  list: vi.fn(),
  continueOn: vi.fn(),
  settings: vi.fn(async () => ({ update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0 } as Record<string, unknown>)),
  save: vi.fn(async () => ({})),
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, subscriptions: m.list, continueOn: m.continueOn, settings: m.settings, saveSettings: m.save } }
})

import { LimitStrip } from './LimitStrip'
import { ContinuedToast } from './ContinuedToast'
import { LimitSetting } from './LimitSetting'
import { clearShared } from '@/lib/refresh'
import { announceContinued, atLimit, continueChoices, limitLine, movedAway, resetContinued } from '@/lib/continueOn'

const NOW = new Date('2026-11-03T16:26:00').getTime()

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: 's1', cwd: '/w/app', status: 'idle', owned: true, agent: 'claude',
    limit_hit: { at: NOW - 60_000, resets_at: NOW + (2 * 60 + 14) * 60_000, window: 'five_hour' },
    ...over,
  } as SessionSummary
}

function moved(over: Partial<ContinueOnResult> = {}): ContinueOnResult {
  return {
    session_id: 's2', cwd: '/w/app', continued_from: 's1', target: 'kimi', from: 'default', how: 'resume',
    same_conversation: true, stopped_original: true, note: '', ...over,
  }
}

beforeEach(() => {
  resetContinued()
  clearShared()
  m.list.mockReset()
  m.continueOn.mockReset()
  m.save.mockClear()
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW })
})
afterEach(() => { vi.useRealTimers() })

describe('the limit strip', () => {
  it('says the window and when it reopens, and lists only the targets that are set up', async () => {
    m.list.mockResolvedValue(response([sub({}), sub({ id: 'a1', label: 'Work', default: false }), sub({ id: 'a2', label: 'Old', default: false, signed_in: false }), deepseek]))
    render(<LimitStrip session={session()} />)
    const strip = await screen.findByRole('status', { name: 'Usage limit' })
    expect(strip).toHaveTextContent(/5-hour limit · back at .+ \(2h 14m\)/)
    await waitFor(() => expect(within(strip).getByRole('button', { name: /Claude · Work/ })).toBeInTheDocument())
    expect(within(strip).getByRole('button', { name: /DeepSeek/ })).toHaveAttribute('title', 'Same session, full context')
    // Not its own sign-in, not a signed-out one, no Kimi without a key, no Codex not installed.
    expect(within(strip).queryByRole('button', { name: /Own sign-in/ })).toBeNull()
    expect(within(strip).queryByRole('button', { name: /Old/ })).toBeNull()
    expect(within(strip).queryByRole('button', { name: /Kimi/ })).toBeNull()
    expect(within(strip).queryByRole('button', { name: /Codex/ })).toBeNull()
  })

  it('posts the target, announces the move, and shows a refusal inline', async () => {
    m.list.mockResolvedValue(response([sub({}), kimi], { installed: true, signedIn: true }))
    m.continueOn.mockRejectedValueOnce(new Error('no Kimi key'))
    const seen: ContinueOnResult[] = []
    const off = (await import('@/lib/continueOn')).onContinued((r) => seen.push(r))
    render(<LimitStrip session={session()} />)
    const codex = await screen.findByRole('button', { name: /Codex/ })
    expect(codex).toHaveAttribute('title', 'New Codex session, starts from a summary')
    fireEvent.click(screen.getByRole('button', { name: /Kimi/ }))
    await waitFor(() => expect(m.continueOn).toHaveBeenCalledWith('s1', 'kimi'))
    expect(await screen.findByRole('alert')).toHaveTextContent('no Kimi key')
    m.continueOn.mockResolvedValueOnce(moved())
    fireEvent.click(screen.getByRole('button', { name: /Kimi/ }))
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]!.session_id).toBe('s2')
    off()
  })

  it('without anywhere to go says so with a link to the keys; Wait hides it for this limit', async () => {
    m.list.mockResolvedValue(response([sub({})]))
    const s = session({ limit_hit: { at: NOW - 1000, window: 'seven_day' } })
    const { rerender } = render(<LimitStrip session={s} />)
    const strip = await screen.findByRole('status', { name: 'Usage limit' })
    expect(strip).toHaveTextContent('Weekly limit')
    expect(strip).not.toHaveTextContent('back at')
    expect(await within(strip).findByRole('button', { name: 'Add DeepSeek or Kimi key' })).toBeInTheDocument()
    fireEvent.click(within(strip).getByRole('button', { name: 'Wait' }))
    expect(screen.queryByRole('status', { name: 'Usage limit' })).toBeNull()
    // A later limit shows again.
    rerender(<LimitStrip session={{ ...s, limit_hit: { at: NOW + 5000, window: 'five_hour' } }} />)
    expect(await screen.findByRole('status', { name: 'Usage limit' })).toHaveTextContent('5-hour limit')
  })

  it('is for an owned, open Claude Code session at its limit only', () => {
    expect(atLimit(session())).toBe(true)
    expect(atLimit(session({ owned: false }))).toBe(false)
    expect(atLimit(session({ status: 'ended' }))).toBe(false)
    expect(atLimit(session({ agent: 'codex' }))).toBe(false)
    expect(atLimit(session({ limit_hit: null }))).toBe(false)
    expect(limitLine({ at: 1, resets_at: NOW - 1 }, NOW)).toEqual({ name: 'Usage limit' })
    // A session already on DeepSeek is offered the own sign-in back, not DeepSeek.
    const c = continueChoices('deepseek', response([sub({}), deepseek]))
    expect(c.map((x) => x.target)).toEqual(['default'])
  })
})

describe('the move toast', () => {
  it('says where it went and when it comes back, and Undo continues it back', async () => {
    m.list.mockResolvedValue(response([sub({})]))
    render(<ContinuedToast />)
    act(() => announceContinued(moved({ auto: true, return_at: NOW + 2 * 3600_000 })))
    const toast = await screen.findByText(/Moved to Kimi · same session · back to Claude at/)
    expect(toast).toBeInTheDocument()
    m.continueOn.mockResolvedValueOnce(moved({ session_id: 's3', continued_from: 's2', target: 'default', from: 'kimi', return_at: undefined }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(m.continueOn).toHaveBeenCalledWith('s2', 'default'))
    expect(await screen.findByText(/Moved to Claude · same session/)).toBeInTheDocument()
  })

  it('names a Codex move a new session from a summary, once per move', async () => {
    m.list.mockResolvedValue(response([sub({})]))
    render(<ContinuedToast />)
    const r = moved({ target: 'codex', how: 'summary', same_conversation: false })
    act(() => { announceContinued(r); announceContinued(r) })
    expect(await screen.findByText(/Moved to Codex · new session from a summary/)).toBeInTheDocument()
    await expect(movedAway('s1', 10)).resolves.toEqual(r)
    await expect(movedAway('other', 10)).resolves.toBeNull()
  })
})

describe('Settings → When a limit is reached', () => {
  it('saves the action, the order and the return, with only the set-up targets enabled', async () => {
    m.settings.mockResolvedValue({ update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0, limit_action: 'ask', limit_fallbacks: ['kimi'], limit_return_after_reset: false })
    m.list.mockResolvedValue(response([sub({}), sub({ id: 'a1', label: 'Work', default: false }), deepseek]))
    render(<LimitSetting />)
    const ask = await screen.findByRole('radio', { name: /Ask me/ })
    expect(ask).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: /Continue automatically on/ }))
    await waitFor(() => expect(m.save).toHaveBeenCalledWith({ limit_action: 'auto' }))
    const list = await screen.findByRole('list', { name: 'Continue on, in this order' })
    // The saved Kimi first, not set up; then the available ones.
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.getAttribute('data-target'))).toEqual(['kimi', 'default', 'a1', 'deepseek'])
    expect(rows[0]).toHaveAttribute('data-off')
    expect(rows[0]).toHaveTextContent('not set up')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move DeepSeek up' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Move DeepSeek up' }))
    await waitFor(() => expect(m.save).toHaveBeenCalledWith({ limit_fallbacks: ['kimi', 'default', 'deepseek', 'a1'] }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Back on Claude after the reset/ }))
    await waitFor(() => expect(m.save).toHaveBeenCalledWith({ limit_return_after_reset: true }))
    fireEvent.click(screen.getByRole('radio', { name: /Wait for the reset/ }))
    await waitFor(() => expect(m.save).toHaveBeenCalledWith({ limit_action: 'wait' }))
  })

  it('choosing automatic with no order saved saves the order shown', async () => {
    m.settings.mockResolvedValue({ update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0, limit_fallbacks: [] })
    m.list.mockResolvedValue(response([sub({}), kimi]))
    render(<LimitSetting />)
    await screen.findByRole('radio', { name: /Ask me/ })
    await waitFor(() => expect(m.list).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('radio', { name: /Continue automatically on/ }))
    await waitFor(() => expect(m.save).toHaveBeenCalledWith({ limit_action: 'auto', limit_fallbacks: ['default', 'kimi'] }))
  })
})
