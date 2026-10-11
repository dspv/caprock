import { beforeEach, describe, expect, it } from 'vitest'
import { isQuickChat, quickChatHint, quickChatTitle, rememberStartedChat } from './quickchat'
import { sessionTitle } from './sidebar'
import type { SessionSummary } from './api'

beforeEach(() => localStorage.clear())

describe('a quick chat', () => {
  it('is known by the dated folder the daemon gives it, on every OS', () => {
    expect(isQuickChat({ cwd: '/Users/me/Library/Application Support/caprock/chats/2026-10-12-005157' })).toBe(true)
    expect(isQuickChat({ cwd: 'C:\\Users\\me\\AppData\\Roaming\\caprock\\chats\\2026-10-12-005157-2' })).toBe(true)
    expect(isQuickChat({ cwd: '/home/me/.local/share/caprock/chats/2026-10-12-005157/' })).toBe(true)
    expect(isQuickChat({ cwd: '/home/me/dev/chats/notes' })).toBe(false)
    expect(isQuickChat({ cwd: '/home/me/dev/caprock' })).toBe(false)
    expect(isQuickChat(undefined)).toBe(false)
  })

  it('is named after the chat and its model, not its folder', () => {
    rememberStartedChat('c1', { agent: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5' })
    const s = { session_id: 'c1', cwd: '/d/caprock/chats/2026-10-12-005157', agent: 'claude', git_branch: '' } as unknown as SessionSummary
    expect(sessionTitle(s)).toBe('Quick chat · Opus 5.5')
    // The pricing table's name wins once it has answered.
    expect(quickChatTitle({ ...s, model_display: 'Sonnet 5.5' })).toBe('Quick chat · Sonnet 5.5')
    // Started elsewhere on the agent's own default: the agent's name.
    expect(quickChatTitle({ session_id: 'c2', agent: 'codex' })).toBe('Quick chat · Codex')
  })

  it('hints the way out in the platform’s words', () => {
    rememberStartedChat('c1', { agent: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5' })
    expect(quickChatHint({ session_id: 'c1' }, '⌘W')).toBe('Quick chat with Claude · Opus 5.5 — ⌘W or /exit ends it')
    expect(quickChatHint({ session_id: 'g', agent: 'gemini' }, 'Ctrl+Shift+W')).toBe('Quick chat with Gemini — Ctrl+Shift+W or /quit ends it')
  })
})
