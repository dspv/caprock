import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import { chatTitle, isChat, newChatRequest, resolveChatPath, sandboxedHTML } from './chats'

const s = (x: Partial<SessionSummary>) => ({ session_id: 'c1', cwd: '/w/x', ...x }) as SessionSummary

describe('chats', () => {
  it('knows a chat by its mark, or by its folder for a daemon from before the mark', () => {
    expect(isChat(s({ chat: true }))).toBe(true)
    expect(isChat(s({ cwd: '/data/caprock/chats/2026-10-16-101010' }))).toBe(true)
    expect(isChat(s({ cwd: '/w/app' }))).toBe(false)
    expect(isChat(undefined)).toBe(false)
  })

  it('names a chat by its name, else its first message, else New chat', () => {
    expect(chatTitle(s({ name: 'Monads', description: 'what is a monad', description_source: 'prompt' }))).toBe('Monads')
    expect(chatTitle(s({ description: 'what is a monad', description_source: 'prompt' }))).toBe('What is a monad')
    expect(chatTitle(s({ title: 'Explaining monads' }))).toBe('Explaining monads')
    expect(chatTitle(s({}))).toBe('New chat')
    const long = chatTitle(s({ title: 'x'.repeat(200) }))
    expect(long.length).toBeLessThanOrEqual(80)
    expect(long.endsWith('…')).toBe(true)
  })

  it('asks the daemon for a chat, never a folder', () => {
    expect(newChatRequest({ agent: 'claude', model: 'claude-opus-5-5' })).toEqual({ chat: true, model: 'claude-opus-5-5' })
    expect(newChatRequest({ agent: 'codex', model: '' }, '  hello ')).toEqual({ chat: true, agent: 'codex', prompt: 'hello' })
  })

  it('reads a picture beside a Markdown file, and nothing outside the chat', () => {
    expect(resolveChatPath('out/report.md', 'chart.png')).toBe('out/chart.png')
    expect(resolveChatPath('out/report.md', '../img/a.png')).toBe('img/a.png')
    expect(resolveChatPath('report.md', '../../etc/passwd')).toBe('')
    expect(resolveChatPath('report.md', 'https://example.com/a.png')).toBe('')
    expect(resolveChatPath('report.md', '/etc/passwd')).toBe('')
  })

  it('puts a policy that fetches nothing in front of an HTML file', () => {
    const html = sandboxedHTML('<img src="https://example.com/x.png">')
    expect(html.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(html).toContain("default-src 'none'")
  })
})
