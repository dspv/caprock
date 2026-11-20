import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionResources } from '@/lib/resources'

const h = vi.hoisted(() => ({ res: new Map<string, SessionResources>() }))

vi.mock('@/lib/resources', async (orig) => {
  const actual = await orig<typeof import('@/lib/resources')>()
  return { ...actual, useSessionResources: (id: string | undefined) => (id ? h.res.get(id) : undefined) }
})

import { CloseShellConfirm, KEEP_KEY, STOP_KEY } from './CloseShellConfirm'
import { keys } from '@/lib/appkeys'

const MB = 2 ** 20
const tree = (id: string, top: [string, number][]): SessionResources => ({
  session_id: id, pid: 1, cpu_pct: 0, mem_bytes: 0, procs: top.length, warm: true, hot: false,
  top: top.map(([name, mb], i) => ({ pid: 100 + i, name, cpu_pct: 0, mem_bytes: mb * MB })),
})

function setPlatform(p: string) {
  Object.defineProperty(navigator, 'platform', { value: p, configurable: true })
}

afterEach(() => { cleanup(); h.res.clear(); setPlatform('MacIntel') })

const claudeIn = [{ sessionId: 'sh1', name: 'Shell 1', program: 'claude', agent: 'Fix the login page' }]

// Owner, 2026-11-20 (translated): the red button's text was hard to see, the
// keys were missing, and it did not say what a stop would end.
describe('the question before closing a busy shell', () => {
  it('names the agent session running there and lists what runs, with memory', () => {
    setPlatform('MacIntel')
    h.res.set('sh1', tree('sh1', [['claude', 260], ['caprock', 11], ['zsh', 3]]))
    render(<CloseShellConfirm busy={claudeIn} onStop={() => {}} onKeep={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('“Fix the login page” is running in Shell 1. Close and stop it?')).toBeInTheDocument()
    const procs = [...document.querySelectorAll('[data-running-proc]')].map((e) => e.textContent)
    expect(procs).toEqual(['claude — “Fix the login page” 260 MB', ' · caprock 11 MB', ' · zsh 3 MB'])
    expect(document.querySelector('[data-running-here]')).toHaveTextContent(/^Running here: /)
  })

  it('says nothing about processes before the meter has a sample', () => {
    render(<CloseShellConfirm busy={[{ sessionId: 'sh1', name: 'Shell 1', program: 'npm' }]} onStop={() => {}} onKeep={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('Shell 1 is running npm. Close and stop it?')).toBeInTheDocument()
    expect(document.querySelectorAll('[data-running-proc]')).toHaveLength(0)
  })

  it('keeps running by default: filled, in focus, Enter; Stop is ⌘Enter and Cancel Esc', () => {
    setPlatform('MacIntel')
    const onStop = vi.fn(), onKeep = vi.fn(), onCancel = vi.fn()
    render(<CloseShellConfirm busy={claudeIn} onStop={onStop} onKeep={onKeep} onCancel={onCancel} />)
    const keep = screen.getByRole('button', { name: /Keep running, close tab/ })
    const stop = screen.getByRole('button', { name: /Stop and close/ })
    expect(keep).toHaveFocus()
    expect(keep).toHaveAttribute('aria-keyshortcuts', 'Enter')
    expect(keep.querySelector('[data-key-chip]')).toHaveTextContent('↩')
    expect(stop).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter')
    expect(stop.querySelector('[data-key-chip]')).toHaveTextContent('⌘↩')
    expect(screen.getByRole('button', { name: /Cancel/ }).querySelector('[data-key-chip]')).toHaveTextContent('Esc')
    fireEvent.keyDown(keep, { key: 'Enter', metaKey: true })
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onKeep).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  it('spells and takes Stop’s key as Windows and Linux do: Ctrl+Enter', () => {
    for (const p of ['Win32', 'Linux x86_64']) {
      setPlatform(p)
      const onStop = vi.fn()
      render(<CloseShellConfirm busy={claudeIn} onStop={onStop} onKeep={() => {}} onCancel={() => {}} />)
      const stop = screen.getByRole('button', { name: /Stop and close/ })
      expect(keys(STOP_KEY, false)).toBe('Ctrl+Enter')
      expect(keys(KEEP_KEY, false)).toBe('Enter')
      expect(stop.querySelector('[data-key-chip]')).toHaveTextContent('Ctrl+Enter')
      expect(stop).toHaveAttribute('aria-keyshortcuts', 'Control+Enter')
      expect(screen.getByRole('button', { name: /Keep running/ }).querySelector('[data-key-chip]')).toHaveTextContent('Enter')
      // ⌘ is not the chord there.
      fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
      expect(onStop).not.toHaveBeenCalled()
      fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
      expect(onStop).toHaveBeenCalledTimes(1)
      cleanup()
    }
  })

  it('draws Stop as the app’s danger button, its label in the on-danger ink, never white', () => {
    render(<CloseShellConfirm busy={claudeIn} onStop={() => {}} onKeep={() => {}} onCancel={() => {}} />)
    const stop = screen.getByRole('button', { name: /Stop and close/ })
    expect(stop.className).toContain('bg-danger')
    expect(stop.className).toContain('text-on-danger')
    expect(stop.className).not.toContain('text-white')
    expect(stop.className).not.toMatch(/(^|\s)opacity-/)
    expect(stop.querySelector('[data-key-chip]')!.className).toContain('text-on-danger')
  })

  it('lists each shell by name when a project closes several', () => {
    h.res.set('sh1', tree('sh1', [['claude', 260]]))
    h.res.set('sh2', tree('sh2', [['npm', 80], ['node', 120]]))
    render(<CloseShellConfirm project="alpha" busy={[...claudeIn, { sessionId: 'sh2', name: 'Shell 2', program: 'npm' }]} onStop={() => {}} onKeep={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('alpha: Shell 1 is running claude (“Fix the login page”), Shell 2 is running npm. Stop them and close?')).toBeInTheDocument()
    const rows = [...document.querySelectorAll('[data-running-here] li')].map((e) => e.textContent)
    expect(rows).toEqual(['Shell 1: claude — “Fix the login page” 260 MB', 'Shell 2: npm 80 MB · node 120 MB'])
  })
})
