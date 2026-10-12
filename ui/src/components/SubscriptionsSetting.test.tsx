import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Subscription, SubscriptionsResponse } from '@/lib/api'

function sub(over: Partial<Subscription>): Subscription {
  return {
    id: 'default', agent: 'claude', label: 'Default', default: true, dir: '/h/.claude', signed_in: true, login_command: 'claude auth login',
    windows: [], sessions_7d: 0, cost_7d_usd: 0, running: 0, ...over,
  }
}

const m = vi.hoisted(() => ({ list: vi.fn(), add: vi.fn(), remove: vi.fn(), update: vi.fn() }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      subscriptions: m.list, addSubscription: m.add, removeSubscription: m.remove, updateSubscription: m.update,
      premium: async () => ({
        yearly: { per_month_usd: 2.5, charged_usd: 30, period: 'year', url: 'https://buy/y' },
        lifetime: { per_month_usd: 0, charged_usd: 100, period: 'once', url: 'https://buy/l' },
        info_url: 'https://caprock.dev/premium/',
        license: { active: false, in_grace: false },
      }),
    },
  }
})

import { SubscriptionsSetting } from './SubscriptionsSetting'
import { SetupShellContext } from '@/lib/setupShell'
import { SubscriptionNote } from './SubscriptionPicker'
import { AccountPlans } from './AccountPlan'

function response(claude: Subscription[], licensed = false): SubscriptionsResponse {
  return {
    agents: [
      { agent: 'claude', label: 'Claude Code', installed: true, subscriptions: claude },
      { agent: 'codex', label: 'Codex', installed: false, subscriptions: [sub({ agent: 'codex', dir: '/h/.codex', signed_in: false })] },
    ],
    licensed, free_per_agent: 3, home: '/h',
  }
}

describe('Settings → Subscriptions', () => {
  // A tester, 2026-10-12: "I can't change the default account."
  it('makes another the default, renames the own one, and forgets the remembered picks', async () => {
    localStorage.setItem('caprock.subscription.claude.p1', 'default')
    localStorage.setItem('caprock.subscription.codex.p1', 'cd34')
    m.list.mockResolvedValue(response([sub({ label: 'Own sign-in', preferred: true }), sub({ id: 'a1', label: 'Work', default: false, account: 'ann@work.example' })]))
    m.update.mockResolvedValue(sub({ id: 'a1', label: 'Work', default: false, preferred: true }))
    render(<SubscriptionsSetting />)
    await screen.findByText('Work')
    // The default is labelled, and only the other one offers Make default.
    expect(screen.getByTitle('New sessions start on it when you pick none')).toHaveTextContent('default')
    expect(screen.getAllByRole('button', { name: 'Make default' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Make default' }))
    await waitFor(() => expect(m.update).toHaveBeenCalledWith('a1', { agent: 'claude', make_default: true }))
    expect(localStorage.getItem('caprock.subscription.claude.p1')).toBeNull()
    expect(localStorage.getItem('caprock.subscription.codex.p1')).toBe('cd34')
    // The own sign-in can be renamed too.
    m.update.mockClear()
    fireEvent.click(screen.getAllByRole('button', { name: 'Rename' })[0]!)
    fireEvent.change(screen.getByLabelText('Subscription name'), { target: { value: 'Home' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(m.update).toHaveBeenCalledWith('default', { agent: 'claude', label: 'Home' }))
  })

  // "I have different plans on the accounts and it's unclear what to choose here."
  it('sets a plan per account; the own one is the main plan', async () => {
    m.update.mockClear()
    m.update.mockResolvedValue(sub({ id: 'a1', default: false }))
    const saveMain = vi.fn()
    const list = [
      sub({ label: 'Own sign-in', account: 'me@example.com' }),
      sub({ id: 'a1', label: 'Work', default: false, plan: { kind: 'flat', label: 'Max 20×', usd_per_month: 200 } }),
      sub({ id: 'b2', label: 'Personal', default: false }),
    ]
    render(<AccountPlans list={list} main={{ update_checks: false, plan_kind: 'flat', plan_label: 'Pro', plan_usd_per_month: 20 }} saveMain={saveMain} />)
    expect(screen.getByRole('button', { name: 'Plan for Work' })).toHaveTextContent('Max 20× · $200.00/mo')
    // No plan of its own: the main one shows, and says so.
    expect(screen.getByRole('button', { name: 'Plan for Personal' })).toHaveTextContent('Pro · $20.00/mo')
    expect(screen.getByText(/No plan of its own/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Plan for Personal' }))
    fireEvent.click(screen.getByRole('button', { name: /Max 5×/ }))
    await waitFor(() => expect(m.update).toHaveBeenCalledWith('b2', { plan: { kind: 'flat', label: 'Max 5×', usd_per_month: 100 } }))
    // Back to the main plan.
    fireEvent.click(screen.getByRole('button', { name: 'Plan for Work' }))
    fireEvent.click(screen.getByRole('button', { name: /The main plan/ }))
    await waitFor(() => expect(m.update).toHaveBeenCalledWith('a1', { plan: null }))
    // The own sign-in's is the main plan.
    fireEvent.click(screen.getByRole('button', { name: 'Plan for Own sign-in' }))
    fireEvent.click(screen.getByRole('button', { name: /Max 20×/ }))
    expect(saveMain).toHaveBeenCalledWith({ plan_kind: 'flat', plan_label: 'Max 20×', plan_usd_per_month: 200 })
  })

  it('adds one and types its sign-in into a shell tab', async () => {
    m.list.mockResolvedValue(response([sub({ account: 'me@example.com' })]))
    const added = sub({ id: 'ab12cd34', label: 'Work', default: false, dir: '/d/profiles/ab12cd34', signed_in: false, env_var: 'CLAUDE_CONFIG_DIR', login_command: "CLAUDE_CONFIG_DIR='/d/profiles/ab12cd34' claude auth login" })
    m.add.mockResolvedValueOnce(added)
    const setup = vi.fn()
    render(<SetupShellContext.Provider value={setup}><SubscriptionsSetting /></SetupShellContext.Provider>)
    expect(await screen.findByText('me@example.com')).toBeInTheDocument()
    // Codex is not installed and has only its Default: not listed.
    expect(screen.queryByRole('list', { name: 'Codex subscriptions' })).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Work Max'), { target: { value: 'Work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add subscription' }))
    await waitFor(() => expect(m.add).toHaveBeenCalledWith('claude', 'Work'))
    await waitFor(() => expect(setup).toHaveBeenCalledWith(added.login_command, '/h'))
  })

  it('shows the Premium path at the free number, without asking the daemon', async () => {
    m.list.mockResolvedValue(response([sub({}), sub({ id: 'a1', label: 'Work', default: false }), sub({ id: 'b2', label: 'Home', default: false })]))
    m.add.mockClear()
    render(<SubscriptionsSetting />)
    expect(await screen.findByText(/the free number/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add subscription' }))
    expect(m.add).not.toHaveBeenCalled()
    expect(await screen.findByText('More sign-ins, each a pick away')).toBeInTheDocument()
  })

  it('asks before removing, and shows the command to copy in a browser', async () => {
    m.list.mockResolvedValue(response([sub({}), sub({ id: 'a1', label: 'Work', default: false, signed_in: false, login_command: 'X=1 claude auth login' })]))
    m.remove.mockResolvedValueOnce(undefined)
    render(<SubscriptionsSetting />)
    await screen.findByText('Work')
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' })[0]!)
    expect(await screen.findByText('X=1 claude auth login')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByText(/Its folder is deleted/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Work' }))
    await waitFor(() => expect(m.remove).toHaveBeenCalledWith('a1'))
  })
})

describe('the near-limit note', () => {
  const soon = Date.now() / 1000 + 3600
  const list = [
    sub({ windows: [{ window: 'five_hour', used_percentage: 93, resets_at: soon, observed_at: 0 }] }),
    sub({ id: 'a1', label: 'Personal', default: false, windows: [{ window: 'five_hour', used_percentage: 12, resets_at: soon, observed_at: 0 }] }),
  ]
  it('says how full the chosen one is and offers one with room for this session', () => {
    const use = vi.fn()
    render(<SubscriptionNote list={list} value="default" onUse={use} />)
    expect(screen.getByRole('note')).toHaveTextContent('Default: 93% of its 5-hour window used')
    fireEvent.click(screen.getByRole('button', { name: 'Personal' }))
    expect(use).toHaveBeenCalledWith('a1')
  })
  it('says nothing when the chosen one has room', () => {
    const { container } = render(<SubscriptionNote list={list} value="a1" onUse={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
