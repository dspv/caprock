/**
 * Every sign-in's limits in the Plan limits panel (ADR-048, owner approved
 * Overview V1 on 2026-11-18), and the figures the Subscription select shows.
 * Pinned: what is LEFT, never "used"; a passed reset reads "reopened", never
 * 0%; a sign-in without a sign-in says so; the on-a-limit place only while
 * that is automatic; and the select still opens on the default one, not on
 * the one with the most left.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Settings, Subscription, SubscriptionsResponse } from '@/lib/api'
import { SubscriptionsOverview, ageText, limitPlace, manySignIns } from './SubscriptionsOverview'
import { SubscriptionPicker, optionText } from './SubscriptionPicker'
import { PlanLimitsPanel } from './PlanLimits'
import { api } from '@/lib/api'

const NOW = Date.parse('2026-11-18T15:51:00Z')
const sec = (min: number) => Math.round((NOW + min * 60_000) / 1000)

function sub(over: Partial<Subscription>): Subscription {
  return {
    id: 'default', agent: 'claude', label: 'Personal', default: true, dir: '/h/.claude', signed_in: true, login_command: 'claude auth login',
    windows: [], sessions_7d: 0, cost_7d_usd: 0, running: 0, ...over,
  }
}

const own = sub({
  preferred: true, account: 'me@example.com', sessions_7d: 23, cost_7d_usd: 412.3, running: 2,
  windows: [
    { window: 'five_hour', used_percentage: 88, resets_at: sec(74), observed_at: NOW - 60_000 },
    { window: 'seven_day', used_percentage: 41, resets_at: sec(3 * 24 * 60), observed_at: NOW - 60_000 },
  ],
})
const work = sub({
  id: 'a1', label: 'Work', default: false, plan: { kind: 'flat', label: 'Max' }, sessions_7d: 11, cost_7d_usd: 186.1, running: 1,
  windows: [
    { window: 'five_hour', used_percentage: 38, resets_at: sec(149), observed_at: NOW - 14 * 60_000 },
    { window: 'seven_day', used_percentage: 30, resets_at: sec(2 * 24 * 60), observed_at: NOW - 14 * 60_000 },
  ],
})
const client = sub({
  id: 'b2', label: 'Client', default: false, sessions_7d: 3, cost_7d_usd: 24.8,
  windows: [
    { window: 'five_hour', used_percentage: 71, resets_at: sec(-250), observed_at: NOW - 6 * 3600_000 },
    { window: 'seven_day', used_percentage: 81, resets_at: sec(4 * 24 * 60), observed_at: NOW - 6 * 3600_000 },
  ],
})
const side = sub({ id: 'c3', label: 'Side project', default: false, signed_in: false })
const deepseek = sub({ id: 'deepseek', label: 'DeepSeek', default: false, dir: '', provider: 'deepseek' })
const codex = sub({ agent: 'codex', label: 'Own sign-in', preferred: true, dir: '/h/.codex', windows: [{ window: 'seven_day', used_percentage: 64, resets_at: sec(16 * 60), observed_at: NOW - 2 * 3600_000 }] })
const ALL = [own, work, client, side, deepseek, codex]

const settings = (over: Partial<Settings> = {}) => ({ update_checks: false, plan_kind: 'flat', plan_label: 'Max', plan_usd_per_month: 100, ...over }) as Settings

describe('the subscriptions overview', () => {
  it('appears only once an agent has more than one sign-in; a provider key is not one', () => {
    expect(manySignIns([own, codex])).toBe(false)
    expect(manySignIns([own, deepseek, codex])).toBe(false)
    expect(manySignIns([own, work])).toBe(true)
  })

  it('lists every sign-in by agent with plan, default, age, what is left and the reset', () => {
    render(<SubscriptionsOverview all={ALL} settings={settings()} now={NOW} />)
    const claude = document.querySelector('[data-sub-agent="claude"]') as HTMLElement
    expect(within(claude).getByText('Claude Code')).toBeTruthy()
    // DeepSeek is a key, not a sign-in: no plan windows to list.
    expect(claude.querySelectorAll('[data-sub-row]')).toHaveLength(4)
    const row = (id: string) => document.querySelector(`[data-sub-row="${id}"]`) as HTMLElement
    // The own sign-in carries the main plan and the default badge.
    expect(row('claude:default').textContent).toContain('PersonalMaxdefault')
    expect(row('claude:default').textContent).toContain('as of 1m ago')
    expect(within(row('claude:default')).getByRole('img', { name: /^5-hour: 12% left, resets/ })).toBeTruthy()
    expect(row('claude:default').textContent).toContain('● 2 running')
    expect(row('claude:default').textContent).toContain('$412.30 at API price')
    expect(row('claude:default').textContent).toContain('23 sessions · 7 days')
    expect(row('claude:a1').textContent).toContain('as of 14m ago')
    expect(row('claude:a1').textContent).toMatch(/62% left.*resets .+ · in 2h 29m/)
    expect(row('claude:a1').textContent).not.toMatch(/used/)
    expect(row('claude:a1').textContent).not.toContain('default')
    // The order is not shown while the setting is not automatic.
    expect(document.querySelector('[data-limit-place]')).toBeNull()
  })

  it('says a passed reset reopened the window, never 0% or 100% left', () => {
    render(<SubscriptionsOverview all={ALL} settings={settings()} now={NOW} />)
    const row = document.querySelector('[data-sub-row="claude:b2"]') as HTMLElement
    const five = row.querySelector('[data-window="5-hour"]') as HTMLElement
    expect(five.hasAttribute('data-reopened')).toBe(true)
    expect(five.textContent).toMatch(/reopened \S/)
    expect(five.textContent).not.toMatch(/%/)
    expect(row.textContent).toContain('19% left')
  })

  it('says a signed-out one is not signed in and offers Sign in', () => {
    render(<SubscriptionsOverview all={ALL} settings={settings()} now={NOW} />)
    const row = document.querySelector('[data-sub-row="claude:c3"]') as HTMLElement
    expect(row.textContent).toContain('not signed in')
    fireEvent.click(within(row).getByRole('button', { name: 'Sign in' }))
    expect(location.hash).toBe('#/settings')
  })

  it('shows each one\'s place in the on-a-limit order while that is automatic', () => {
    const s = settings({ limit_action: 'auto', limit_fallbacks: ['a1', 'codex', 'kimi'] })
    expect(limitPlace(work, s)).toBe(1)
    expect(limitPlace(codex, s)).toBe(2)
    expect(limitPlace(own, s)).toBe(0)
    expect(limitPlace(sub({ agent: 'codex', id: 'x9', default: false }), s)).toBeUndefined()
    expect(limitPlace(work, settings({ limit_action: 'ask', limit_fallbacks: ['a1'] }))).toBeUndefined()
    render(<SubscriptionsOverview all={ALL} settings={s} now={NOW} />)
    expect(document.querySelector('[data-sub-row="claude:a1"] [data-limit-place]')?.textContent).toBe('on a limit: 1st')
    expect(document.querySelector('[data-sub-row="claude:default"] [data-limit-place]')?.textContent).toBe('not in the on-a-limit order')
  })

  it('ages figures in plain words', () => {
    expect(ageText(NOW - 20_000, NOW)).toBe('just now')
    expect(ageText(NOW - 14 * 60_000, NOW)).toBe('14m ago')
    expect(ageText(NOW - 125 * 60_000, NOW)).toBe('2h 5m ago')
  })
})

describe('the Subscription select', () => {
  it('says how much is left of each one\'s tightest window', () => {
    const nowSec = NOW / 1000
    expect(optionText(own, nowSec)).toBe('Personal (default) · 12% of 5-hour left')
    expect(optionText(work, nowSec)).toBe('Work · 62% of 5-hour left')
    expect(optionText(client, nowSec)).toBe('Client · 19% of weekly left')
    expect(optionText(side, nowSec)).toBe('Side project · not signed in')
    expect(optionText(sub({ id: 'z', label: 'New', default: false }), nowSec)).toBe('New · no figures yet')
    expect(optionText(deepseek, nowSec)).toBe('DeepSeek · your API key')
  })

  it('opens on the chosen one, not on the one with the most left', () => {
    render(<SubscriptionPicker list={[own, work, client]} value="default" onChange={() => {}} />)
    const select = screen.getByLabelText<HTMLSelectElement>('Subscription')
    expect(select.value).toBe('default')
  })
})

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      settings: async () => ({ update_checks: false, plan_kind: 'flat', plan_label: 'Max', plan_usd_per_month: 100 }),
      subscriptions: vi.fn(),
    },
  }
})

describe('the Plan limits panel', () => {
  it('lists the sign-ins instead of the cards, with where the figures come from', async () => {
    const list: SubscriptionsResponse = {
      agents: [
        { agent: 'claude', label: 'Claude Code', installed: true, subscriptions: [own, work, client, side] },
        { agent: 'codex', label: 'Codex', installed: true, subscriptions: [codex] },
      ],
      licensed: false, free_per_agent: 3,
    }
    vi.mocked(api.subscriptions).mockResolvedValue(list)
    render(<PlanLimitsPanel now={NOW} limits={{ five_hour: { used_percentage: 88, resets_at: sec(74) } }} codex={undefined} />)
    await waitFor(() => expect(document.querySelector('[data-subscriptions-overview]')).toBeTruthy())
    expect(document.querySelector('[data-limit-card]')).toBeNull()
    const footer = document.querySelector('[data-overview-source]')?.textContent ?? ''
    expect(footer).toContain("isn't seen here")
    expect(footer).toContain('API list price, not your bill')
    // Near the line, the advice names the other Claude sign-in with the most
    // left, as a choice for a new session, before Codex.
    expect(document.body.textContent).toMatch(/or choose Work for a new session — 62% of 5-hour left\./)
    expect(document.body.textContent).not.toMatch(/switch to Codex/)
  })
})
