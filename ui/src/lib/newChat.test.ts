import { beforeEach, describe, expect, it } from 'vitest'
import type { FolderLabel, Subscription, SubscriptionsResponse } from './api'
import { chatModelLabel } from './chats'
import { contextLine, filterByLabel, folderChatRequest, inProjectFolder, labelFor, rememberedWho, rememberWho, whoChoice, whoOptions } from './newChat'

function sub(over: Partial<Subscription>): Subscription {
  return {
    id: 'default', agent: 'claude', label: 'Own sign-in', default: true, dir: '/h/.claude', signed_in: true, login_command: '',
    windows: [], sessions_7d: 0, cost_7d_usd: 0, running: 0, ...over,
  }
}

function subs(claude: Subscription[], codex = true): SubscriptionsResponse {
  return {
    agents: [
      { agent: 'claude', label: 'Claude Code', installed: true, subscriptions: claude },
      { agent: 'codex', label: 'Codex', installed: codex, subscriptions: [sub({ agent: 'codex', dir: '/h/.codex', signed_in: codex })] },
    ],
    licensed: false, free_per_agent: 3, home: '/h',
  }
}

const deepseek = sub({ id: 'deepseek', label: 'DeepSeek', default: false, dir: '', provider: 'deepseek' })
const kimi = sub({ id: 'kimi', label: 'Kimi', default: false, dir: '', provider: 'kimi' })

beforeEach(() => localStorage.clear())

describe('who works', () => {
  it('offers Claude, the providers whose keys are set, Codex, then the other agents', () => {
    const o = whoOptions(['claude', 'codex', 'gemini'], subs([sub({}), deepseek, sub({ ...kimi, signed_in: false })]))
    expect(o.map((x) => x.label)).toEqual(['Claude', 'DeepSeek', 'Codex', 'Gemini'])
    expect(o[0]).toMatchObject({ agent: 'claude', subscription: 'default', hint: 'Your Claude subscription' })
    expect(o[1]).toMatchObject({ agent: 'claude', subscription: 'deepseek', provider: 'deepseek', hint: 'Your DeepSeek API key' })
    expect(o[2]).toMatchObject({ agent: 'codex', subscription: 'default', hint: 'ChatGPT sign-in' })
  })

  it('lists Kimi with its key, another Claude sign-in, and nothing for an agent not here', () => {
    const o = whoOptions(['claude'], subs([sub({}), sub({ id: 'a1', label: 'Work', default: false }), kimi], false))
    expect(o.map((x) => x.key)).toEqual(['claude:default', 'claude:a1', 'claude:kimi'])
  })

  it('offers Claude and Codex plain where the subscriptions are not served', () => {
    expect(whoOptions(['claude', 'codex'], undefined).map((x) => [x.key, x.subscription])).toEqual([['claude:', undefined], ['codex:', undefined]])
  })

  it('remembers the last pick while it is still offered', () => {
    const o = whoOptions(['claude'], subs([sub({}), kimi]))
    rememberWho(o[1]!)
    expect(rememberedWho(o)?.key).toBe('claude:kimi')
    expect(rememberedWho(whoOptions(['claude'], subs([sub({})])))).toBeUndefined()
  })

  it('keeps the remembered model for the same agent, and sends none to a provider', () => {
    const [claude, k] = whoOptions(['claude'], subs([sub({}), kimi]))
    const current = { agent: 'claude' as const, model: 'claude-opus-5-5' }
    expect(whoChoice(claude!, current)).toEqual({ agent: 'claude', model: 'claude-opus-5-5', subscription: 'default' })
    expect(whoChoice(k!, current)).toEqual({ agent: 'claude', model: '', subscription: 'kimi' })
  })
})

describe('where', () => {
  it('asks for a chat in the folder picked, or in one of its own', () => {
    expect(folderChatRequest({ agent: 'claude', model: '', subscription: 'kimi' }, '/h/dev/acme')).toEqual({ chat: true, cwd: '/h/dev/acme', subscription: 'kimi' })
    expect(folderChatRequest({ agent: 'codex', model: 'gpt-5.5' })).toEqual({ chat: true, agent: 'codex', model: 'gpt-5.5' })
  })

  it('finds the label that covers a folder: its own, else the nearest parent', () => {
    const labels: FolderLabel[] = [
      { dir: '/h/dev', label: 'work', updated_at: 1 },
      { dir: '/h/dev/side', label: 'personal', updated_at: 2 },
    ]
    expect(labelFor('/h/dev/acme', labels)).toBe('work')
    expect(labelFor('/h/dev/side/app', labels)).toBe('personal')
    expect(labelFor('/h/dev/side', labels)).toBe('personal')
    expect(labelFor('/h/devx', labels)).toBeUndefined()
    expect(labelFor('C:\\h\\dev\\acme', [{ dir: 'C:\\h\\dev', label: 'work', updated_at: 1 }])).toBe('work')
    const items = [{ cwd: '/h/dev/acme' }, { cwd: '/h/dev/side/app' }, { cwd: '/data/chats/2026-11-05-101010' }]
    expect(filterByLabel(items, 'work', labels)).toEqual([items[0]])
    expect(filterByLabel(items, 'all', labels)).toHaveLength(3)
  })

  it('says what the agent sees and who gets what it reads', () => {
    const own = { cwd: '/data/chats/2026-11-05-101010', chat: true, agent: 'claude' as const }
    const here = { cwd: '/h/dev/acme', chat: true, agent: 'claude' as const, subscription: 'kimi' }
    expect(inProjectFolder(own)).toBe(false)
    expect(inProjectFolder(here)).toBe(true)
    expect(contextLine(own)).toBe('Sees only its own folder · only Anthropic gets what it reads')
    expect(contextLine(here, '/h')).toBe('Sees ~/dev/acme · only Kimi gets what it reads')
    expect(contextLine({ cwd: '/h/x', chat: true, agent: 'codex' }, '/h')).toBe('Sees ~/x · only OpenAI gets what it reads')
    expect(chatModelLabel({ session_id: 'k', agent: 'claude', subscription: 'kimi', model_display: 'kimi-k2' })).toBe('Kimi · kimi-k2')
  })
})
