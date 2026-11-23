import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal as Xterm } from '@xterm/xterm'

const status = vi.hoisted(() => ({ platform: 'darwin/arm64', calls: 0 }))
vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return { ...actual, api: { ...actual.api, status: async () => { status.calls++; return { platform: status.platform } } } }
})

import {
  attachVoiceWatch, daemonPlatform, findVoiceFailure, hideVoice, isVoiceHidden, macDaemon, resetDaemonPlatform,
  restartMode, restartWhen, VOICE_FAILURES, VOICE_SCAN_MS, voiceTab,
} from './termvoice'

const rows = (...lines: string[]) => lines.map((text) => ({ text, wrapped: false }))

describe('the voice failure line', () => {
  it('matches both of Claude Code\'s failure strings', () => {
    expect(findVoiceFailure(rows('> /voice', 'No audio detected from microphone.', ''), 80)).toBe(true)
    expect(findVoiceFailure(rows('  ⎿ Microphone access is denied. Allow it in System Settings'), 80)).toBe(true)
    expect(VOICE_FAILURES).toHaveLength(2)
  })

  it('matches nothing else', () => {
    expect(findVoiceFailure(rows('microphone', 'No audio', 'Voice mode on', 'you-said:hello'), 80)).toBe(false)
    expect(findVoiceFailure([], 80)).toBe(false)
  })

  it('finds the line across rows xterm wrapped', () => {
    const line = 'No audio detected from microphone'
    expect(findVoiceFailure([{ text: line.slice(0, 20), wrapped: false }, { text: line.slice(20), wrapped: true }], 20)).toBe(true)
  })
})

describe('where the strip goes', () => {
  it('an agent tab on a Claude Code session Caprock started, only', () => {
    expect(voiceTab({ shell: false, agent: 'claude', owned: true })).toBe(true)
    expect(voiceTab({ shell: false, owned: true })).toBe(true)
    expect(voiceTab({ shell: true, agent: 'claude', owned: true })).toBe(false)
    expect(voiceTab({ shell: false, agent: 'claude', owned: false })).toBe(false)
    expect(voiceTab({ shell: false, agent: 'codex', owned: true })).toBe(false)
  })

  it('a daemon on macOS only', () => {
    expect(macDaemon('darwin/arm64')).toBe(true)
    expect(macDaemon('darwin/amd64')).toBe(true)
    expect(macDaemon('windows/amd64')).toBe(false)
    expect(macDaemon('linux/amd64')).toBe(false)
    expect(macDaemon(undefined)).toBe(false)
    expect(macDaemon('')).toBe(false)
  })

  it('asks the daemon its platform once', async () => {
    resetDaemonPlatform()
    status.calls = 0
    expect(await daemonPlatform()).toBe('darwin/arm64')
    expect(await daemonPlatform()).toBe('darwin/arm64')
    expect(status.calls).toBe(1)
  })
})

describe('idle or busy', () => {
  it('restarts now at the prompt, waits while the agent works or a prompt is up', () => {
    expect(restartWhen({ waiting: '' })).toBe('now')
    expect(restartWhen({})).toBe('now')
    expect(restartWhen({ waiting: 'turn' })).toBe('idle')
    expect(restartWhen({ waiting: 'permission' })).toBe('idle')
    expect(restartWhen({ waiting: 'question' })).toBe('idle')
  })

  it('resumes in the mode the session is in now', () => {
    expect(restartMode({ mode: 'bypassPermissions' })).toBe('bypassPermissions')
    expect(restartMode({ mode: '' })).toBe('default')
    expect(restartMode(null)).toBe('default')
  })
})

describe('dismiss', () => {
  afterEach(() => localStorage.clear())

  it('is per session and survives a reload', () => {
    expect(isVoiceHidden('a')).toBe(false)
    hideVoice('a')
    expect(isVoiceHidden('a')).toBe(true)
    expect(isVoiceHidden('b')).toBe(false)
  })

  it('keeps the newest hundred', () => {
    for (let i = 0; i < 120; i++) hideVoice(`s${i}`, i)
    expect(isVoiceHidden('s119')).toBe(true)
    expect(isVoiceHidden('s0')).toBe(false)
  })
})

describe('attachVoiceWatch on a real xterm', () => {
  let term: Xterm | undefined
  afterEach(() => { term?.dispose(); term = undefined })
  const write = (t: Xterm, s: string) => new Promise<void>((r) => t.write(s, r))
  const settle = () => new Promise((r) => setTimeout(r, VOICE_SCAN_MS + 50))

  it('calls once when the line is printed', async () => {
    term = new Xterm({ cols: 60, rows: 12, allowProposedApi: true })
    let seen = 0
    const w = attachVoiceWatch(term, () => true, () => seen++)
    await write(term, 'fake-claude ready\r\n')
    await settle()
    expect(seen).toBe(0)
    await write(term, 'Microphone access is denied.\r\n')
    await settle()
    await write(term, 'No audio detected from microphone.\r\n')
    await settle()
    expect(seen).toBe(1)
    w.dispose()
  })

  it('finds the line at the top of a tall screen, its bottom rows blank', async () => {
    term = new Xterm({ cols: 80, rows: 60, allowProposedApi: true })
    let seen = 0
    const w = attachVoiceWatch(term, () => true, () => seen++)
    await write(term, 'fake-claude ready\r\nNo audio detected from microphone.\r\n')
    await settle()
    expect(seen).toBe(1)
    w.dispose()
  })

  it('finds the line already drawn once the pane turns on, with nothing written after', async () => {
    term = new Xterm({ cols: 100, rows: 20, allowProposedApi: true })
    let seen = 0
    let on = false
    const w = attachVoiceWatch(term, () => on, () => seen++)
    // Claude Code's footer under its input box, the spaces cursor jumps, the
    // cursor back in the box: the screen a reloaded page replays.
    const footer = 'No audio detected from microphone. Check that the correct input device is selected and… · ✔ Update installed · /restart t…'
    let drawn = `${'─'.repeat(100)}\r\n❯ \r\n${'─'.repeat(100)}\r\n`
    for (let i = 0; i < footer.length; i++) if (footer[i] !== ' ') drawn += `\x1b[${i + 1}G\x1b[2;31m${footer[i]}\x1b[22;39m`
    await write(term, `\x1b[?2026h${drawn}\r\x1b[2A\x1b[3G\x1b[?2026l`)
    await settle()
    expect(seen).toBe(0)
    on = true
    await settle()
    expect(seen).toBe(0) // no write, no scan
    w.rescan()
    await settle()
    expect(seen).toBe(1)
    w.rescan()
    await settle()
    expect(seen).toBe(1)
    w.dispose()
  })

  it('never scans a pane it is off for', async () => {
    term = new Xterm({ cols: 60, rows: 12, allowProposedApi: true })
    let seen = 0
    const enabled = vi.fn(() => false)
    const w = attachVoiceWatch(term, enabled, () => seen++)
    await write(term, 'No audio detected from microphone.\r\n')
    await settle()
    expect(seen).toBe(0)
    w.dispose()
  })
})
