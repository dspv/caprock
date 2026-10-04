import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const install = vi.hoisted(() => ({ result: { hooks: { missing: [] as string[] } } as unknown, calls: 0 }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, installHooks: async () => { install.calls++; return install.result } } }
})

import { HooksBanner, hooksKey } from './HooksBanner'

const PATH = '/tmp/preview-home/.claude/settings.json'

describe('the hooks banner', () => {
  beforeEach(() => {
    localStorage.clear()
    install.calls = 0
    install.result = { hooks: { missing: [] } }
  })

  it('names the file it checked, installs on a click, and says what that changes', async () => {
    render(<HooksBanner missing={['Stop', 'PreToolUse']} settingsPath={PATH} />)
    expect(screen.getByText(PATH)).toBeTruthy()
    expect(screen.getByText('caprock hooks install')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Install hooks' }))
    expect(await screen.findByText('Hooks installed ✓')).toBeTruthy()
    expect(install.calls).toBe(1)
    expect(document.body.textContent).toContain('until it is restarted')
  })

  it('says so when the install leaves events missing', async () => {
    install.result = { hooks: { missing: ['Stop'] } }
    render(<HooksBanner missing={['Stop']} settingsPath={PATH} />)
    fireEvent.click(screen.getByRole('button', { name: 'Install hooks' }))
    expect(await screen.findByText(/Could not install: 1 still missing: Stop/)).toBeTruthy()
  })

  it('can be dismissed, and stays dismissed for the same missing set', () => {
    const { unmount } = render(<HooksBanner missing={['Stop', 'PreToolUse']} settingsPath={PATH} />)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(screen.queryByText('Hooks not installed')).toBeNull()
    unmount()
    // Same set in another order: still dismissed.
    render(<HooksBanner missing={['PreToolUse', 'Stop']} settingsPath={PATH} />)
    expect(screen.queryByText('Hooks not installed')).toBeNull()
  })

  it('comes back when the missing set changes', () => {
    localStorage.setItem('caprock-hooks-banner-dismissed', hooksKey(['Stop']))
    render(<HooksBanner missing={['Stop', 'SessionStart']} settingsPath={PATH} />)
    expect(screen.getByText('Hooks not installed')).toBeTruthy()
  })

  it('draws nothing when no hook is missing', () => {
    const { container } = render(<HooksBanner missing={[]} settingsPath={PATH} />)
    expect(container.textContent).toBe('')
  })
})
