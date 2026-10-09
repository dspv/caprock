import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, agentModels: async () => ({ agent: 'codex', default: 'gpt-5.5', models: [{ id: 'gpt-5.5', label: 'gpt-5.5' }, { id: 'gpt-5.5-mini', label: 'gpt-5.5-mini' }] }) } }
})
vi.mock('@/lib/appmode', async (orig) => ({ ...(await orig<typeof import('@/lib/appmode')>()), isMacPlatform: () => true }))

import { QuickChatSheet, quickChatRequest, quickModels, rememberQuickChoice, rememberedQuickChoice } from './QuickChat'

beforeEach(() => { localStorage.clear() })

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

  it('offers each agent’s models as the New agent sheet labels them', () => {
    expect(quickModels('claude').map(([v]) => v)).toContain('claude-sonnet-5-5')
    expect(quickModels('codex', { default: 'gpt-5.5', models: [{ id: 'gpt-5.5', label: 'gpt-5.5' }, { id: 'o9', label: 'o9' }] })).toEqual([['', 'gpt-5.5 (default)'], ['o9', 'o9']])
    expect(quickModels('opencode')).toEqual([['', 'OpenCode default']])
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
})
