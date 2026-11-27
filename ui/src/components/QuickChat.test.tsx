import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogEntry } from '@/lib/api'

const entry = (id: string, more: Partial<CatalogEntry> = {}): CatalogEntry => ({ id, label: id, installed: true, ready: true, models: [], observed: true, prompt: true, ...more })
const catalog = vi.hoisted(() => ({ agents: [] as unknown[] }))
const inbox = vi.hoisted(() => ({ items: [] as unknown[], removed: [] as number[] }))
const subs = vi.hoisted(() => ({ value: undefined as unknown, add: (async () => ({})) as (agent: string, label: string) => Promise<unknown> }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      agentCatalog: async () => ({ agents: catalog.agents, home: '/h' }),
      inbox: async () => ({ items: inbox.items, max: 500 }),
      removeInbox: async (id: number) => { inbox.removed.push(id) },
      subscriptions: async () => { if (!subs.value) throw new Error('not offered'); return subs.value },
      addSubscription: async (agent: string, label: string) => subs.add(agent, label),
    },
  }
})
vi.mock('@/lib/appmode', async (orig) => ({ ...(await orig<typeof import('@/lib/appmode')>()), isMacPlatform: () => true }))

import { QuickChatSheet, quickChatRequest, quickModels, rememberQuickChoice, rememberedQuickChoice } from './QuickChat'

beforeEach(() => { localStorage.clear(); catalog.agents = []; inbox.items = []; inbox.removed = []; subs.value = undefined })

/** ADR-048: a second sign-in, found where a chat is started (owner, 2026-11-18). */
describe('Add subscription in Quick chat', () => {
  const sub = (id: string, label: string, more: Record<string, unknown> = {}) => ({
    id, agent: 'claude', label, default: id === 'default', dir: `/d/${id}`, signed_in: true, login_command: 'claude auth login',
    windows: [], sessions_7d: 0, cost_7d_usd: 0, running: 0, ...more,
  })
  const state = (list: unknown[]) => ({ home: '/h', agents: [{ agent: 'claude', label: 'Claude Code', installed: true, subscriptions: list }] })

  it('is a quiet link with one sign-in, and adds one in place that the chat then starts on', async () => {
    subs.value = state([sub('default', 'Own sign-in')])
    const added = sub('w1', 'Work', { signed_in: false, login_command: 'CLAUDE_CONFIG_DIR=/d/w1 claude auth login' })
    subs.add = async () => { subs.value = state([sub('default', 'Own sign-in'), added]); return added }
    const onSetup = vi.fn()
    const onStart = vi.fn()
    render(<QuickChatSheet agents={['claude']} onStart={onStart} onClose={() => {}} onSetup={onSetup} />)
    const link = await screen.findByRole('button', { name: 'Add subscription' })
    expect(screen.queryByLabelText('Subscription')).toBeNull()
    // Enter on the link opens it; it does not start the chat.
    fireEvent.keyDown(link, { key: 'Enter' })
    expect(onStart).not.toHaveBeenCalled()
    fireEvent.click(link)
    const name = await screen.findByPlaceholderText('Work Max')
    fireEvent.change(name, { target: { value: 'Work' } })
    // Enter in Name adds; it does not start the chat either.
    fireEvent.keyDown(name, { key: 'Enter' })
    expect(onStart).not.toHaveBeenCalled()
    await waitFor(() => expect(onSetup).toHaveBeenCalledWith('CLAUDE_CONFIG_DIR=/d/w1 claude auth login', '/h'))
    await waitFor(() => expect(screen.getByLabelText<HTMLSelectElement>('Subscription').value).toBe('w1'))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' })
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ agent: 'claude', subscription: 'w1' }))
  })

  it('is the last option of the picker with two, and opens the add form', async () => {
    subs.value = state([sub('default', 'Own sign-in'), sub('ab12', 'Personal')])
    render(<QuickChatSheet agents={['claude']} onStart={() => {}} onClose={() => {}} />)
    const select = await screen.findByLabelText<HTMLSelectElement>('Subscription')
    expect([...select.options].map((o) => o.text)).toEqual(['Own sign-in · no figures yet', 'Personal · no figures yet', 'Add subscription…'])
    fireEvent.change(select, { target: { value: '__add__' } })
    expect(await screen.findByPlaceholderText('Work Max')).toBeInTheDocument()
    expect(select.value).toBe('default')
  })
})

describe('the quick chat choice', () => {
  it('is Claude Code on its default until something else was used', () => {
    expect(rememberedQuickChoice(['claude', 'codex'])).toEqual({ agent: 'claude', model: 'claude-opus-5-5' })
    rememberQuickChoice({ agent: 'gemini', model: 'gemini-3.5-flash' })
    expect(rememberedQuickChoice(['claude', 'gemini'])).toEqual({ agent: 'gemini', model: 'gemini-3.5-flash' })
    // Gemini since uninstalled: the first agent here, on its default.
    expect(rememberedQuickChoice(['codex'])).toEqual({ agent: 'codex', model: '' })
  })

  it('asks the daemon for a chat on that agent and model', () => {
    expect(quickChatRequest({ agent: 'claude', model: 'claude-haiku-5-5' })).toEqual({ chat: true, model: 'claude-haiku-5-5' })
    expect(quickChatRequest({ agent: 'codex', model: '' })).toEqual({ chat: true, agent: 'codex' })
  })

  it('starts on the subscription last picked for quick chats (ADR-048)', () => {
    localStorage.setItem('caprock.subscription.claude.-', 'ab12')
    const c = rememberedQuickChoice(['claude'])
    expect(c).toEqual({ agent: 'claude', model: 'claude-opus-5-5', subscription: 'ab12' })
    expect(quickChatRequest(c)).toEqual({ chat: true, model: 'claude-opus-5-5', subscription: 'ab12' })
    // An agent without subscriptions never carries one.
    expect(quickChatRequest({ agent: 'gemini', model: '', subscription: 'ab12' })).toEqual({ chat: true, agent: 'gemini' })
  })

  it('offers each agent’s models as the New agent sheet labels them', () => {
    expect(quickModels('claude').map(([v]) => v)).toContain('claude-sonnet-5-5')
    expect(quickModels('codex', entry('codex', { label: 'Codex', default: 'gpt-5.5', models: [{ id: 'gpt-5.5', label: 'gpt-5.5' }, { id: 'o9', label: 'o9' }] }))).toEqual([['', 'gpt-5.5 (default)'], ['o9', 'o9']])
    expect(quickModels('opencode')).toEqual([['', 'OpenCode default']])
    expect(quickModels('opencode', entry('opencode', { label: 'OpenCode', models: [{ id: 'deepseek/deepseek-chat', label: 'DeepSeek · DeepSeek Chat' }] }))).toEqual([['', 'OpenCode default'], ['deepseek/deepseek-chat', 'DeepSeek · DeepSeek Chat']])
  })
})

describe('the chooser', () => {
  it('starts on the remembered choice with Enter', () => {
    rememberQuickChoice({ agent: 'claude', model: 'claude-sonnet-5-5' })
    const onStart = vi.fn()
    render(<QuickChatSheet agents={['claude', 'codex', 'gemini']} onStart={onStart} onClose={() => {}} />)
    const list = screen.getByRole('listbox', { name: 'Claude model' })
    expect(list).toHaveFocus()
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(onStart).toHaveBeenCalledWith({ agent: 'claude', model: 'claude-sonnet-5-5' })
  })

  it('starts another vendor’s model in two clicks', () => {
    const onStart = vi.fn()
    render(<QuickChatSheet agents={['claude', 'codex', 'gemini']} onStart={onStart} onClose={() => {}} />)
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Claude', 'Codex', 'Gemini'])
    fireEvent.click(screen.getByRole('radio', { name: 'Gemini' }))
    fireEvent.click(screen.getByRole('option', { name: /Flash 2.5/ }))
    expect(onStart).toHaveBeenCalledWith({ agent: 'gemini', model: 'gemini-2.5-flash' })
  })

  it('moves between agents and models from the keyboard', () => {
    const onStart = vi.fn()
    render(<QuickChatSheet agents={['claude', 'gemini']} onStart={onStart} onClose={() => {}} />)
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: 'Gemini' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: '1', metaKey: true })
    fireEvent.keyDown(list, { key: '2', metaKey: true })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(onStart).toHaveBeenCalledWith({ agent: 'gemini', model: 'gemini-2.5-flash' })
  })

  it('offers only the agents installed here', () => {
    render(<QuickChatSheet agents={['codex']} onStart={() => {}} onClose={() => {}} />)
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Codex'])
  })

  // The owner's report (2026-10-10): OpenCode offered an empty list. Now it
  // says what is missing and offers to type the fix into a shell tab.
  it('says when OpenCode has no provider, and offers to connect one', async () => {
    catalog.agents = [entry('claude', { label: 'Claude Code' }), entry('opencode', { label: 'OpenCode', ready: false, setup: { reason: 'no_provider', text: 'OpenCode has no model provider connected, so it has no models to offer.', command: 'opencode auth login', docs: 'https://opencode.ai/docs/providers/' } })]
    const onSetup = vi.fn()
    const onClose = vi.fn()
    render(<QuickChatSheet agents={['claude', 'opencode']} onStart={() => {}} onClose={onClose} onSetup={onSetup} />)
    fireEvent.click(screen.getByRole('radio', { name: 'OpenCode' }))
    expect(await screen.findByText(/no model provider connected/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connect a provider' }))
    expect(onSetup).toHaveBeenCalledWith('opencode auth login', '/h')
    expect(onClose).toHaveBeenCalled()
  })

  it('names the agents that are not installed, each one click from its install', async () => {
    catalog.agents = [entry('claude', { label: 'Claude Code' }), entry('grok', { label: 'Grok', installed: false, ready: false, observed: false, setup: { reason: 'not_installed', text: 'Grok is not installed on this machine.', command: 'curl -fsSL https://x.ai/cli/install.sh | bash', docs: 'https://docs.x.ai/build/overview' } })]
    const onStart = vi.fn()
    render(<QuickChatSheet agents={['claude']} onStart={onStart} onClose={() => {}} onSetup={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Grok' }))
    expect(screen.getByText('Grok is not installed on this machine.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Install in a shell tab' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Back to the agents here/ }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })
})

describe('the Inbox in the chooser', () => {
  const saved = [
    { id: 7, text: 'Queue the CI flake check', files: ['/d/inbox/x/IMG 1.png'], project_id: 3, project_root: '/work/alpha', project_name: 'alpha', from_device: 'iPhone · home screen', created_at: Date.now() - 60_000 },
    { id: 6, text: 'an idea', files: [], created_at: Date.now() - 3_600_000 },
  ]

  it('draws nothing while the Inbox is empty', async () => {
    render(<QuickChatSheet agents={['claude']} onStart={() => {}} onClose={() => {}} />)
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByRole('region', { name: 'Saved' })).toBeNull()
  })

  it('lists what was saved, newest first, with where and from which phone', async () => {
    inbox.items = saved
    render(<QuickChatSheet agents={['claude']} onStart={() => {}} onClose={() => {}} />)
    const section = await screen.findByRole('region', { name: 'Saved' })
    expect(section).toHaveTextContent('Queue the CI flake check')
    expect(section).toHaveTextContent('alpha · iPhone · home screen')
    expect(section).toHaveTextContent('Inbox')
  })

  it('starts a chat from an item on the agent picked, in its project, with the item as the first message', async () => {
    inbox.items = saved
    rememberQuickChoice({ agent: 'claude', model: 'claude-sonnet-5-5' })
    const onStart = vi.fn()
    render(<QuickChatSheet agents={['claude', 'codex']} onStart={onStart} onClose={() => {}} />)
    const [first] = await screen.findAllByRole('button', { name: /Start a chat/ }, { timeout: 5000 })
    fireEvent.click(first!)
    expect(onStart).toHaveBeenCalledWith({ agent: 'claude', model: 'claude-sonnet-5-5', prompt: 'Queue the CI flake check\n\n"/d/inbox/x/IMG 1.png"', cwd: '/work/alpha' })
    const req = quickChatRequest(onStart.mock.calls[0]![0])
    expect(req).toEqual({ cwd: '/work/alpha', prompt: 'Queue the CI flake check\n\n"/d/inbox/x/IMG 1.png"', model: 'claude-sonnet-5-5' })
    // The message and folder are this chat's, never remembered for the next.
    rememberQuickChoice(onStart.mock.calls[0]![0])
    expect(rememberedQuickChoice(['claude'])).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5' })
  })

  it('deletes on the second click, not the first', async () => {
    inbox.items = saved
    render(<QuickChatSheet agents={['claude']} onStart={() => {}} onClose={() => {}} />)
    const [del] = await screen.findAllByRole('button', { name: 'Delete' })
    fireEvent.click(del!)
    expect(inbox.removed).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Delete it and its files' }))
    await waitFor(() => expect(inbox.removed).toEqual([7]))
    await waitFor(() => expect(screen.queryByText('Queue the CI flake check')).toBeNull())
  })
})
