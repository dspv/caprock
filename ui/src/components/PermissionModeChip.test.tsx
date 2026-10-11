/**
 * The permission-mode chip (ADR-054): the mode a session runs in, changeable
 * from here only for a Claude Code session Caprock started.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '@/lib/live'
import { ApiError, type PermissionModeView } from '@/lib/api'
import { PermissionModeChip } from './PermissionModeChip'

const h = vi.hoisted(() => ({
  mode: vi.fn(),
  set: vi.fn(),
  accept: vi.fn(),
  status: vi.fn(),
  canControl: true,
  subs: new Set<(f: Frame) => void>(),
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, permissionMode: h.mode, setPermissionMode: h.set, acceptBypass: h.accept, status: h.status } }
})
vi.mock('@/lib/live', () => ({
  useLiveConn: () => 'open',
  live: { onFrame: (fn: (f: Frame) => void) => { h.subs.add(fn); return () => { h.subs.delete(fn) } } },
}))
vi.mock('@/lib/useCanControl', () => ({ useCanControl: () => h.canControl }))

const owned: PermissionModeView = {
  session_id: 's1', mode: 'acceptEdits', source: 'screen', switchable: true,
  in_session: ['default', 'acceptEdits', 'plan', 'auto'], restart: ['bypassPermissions', 'dontAsk'],
}

beforeEach(() => {
  h.mode.mockReset().mockResolvedValue(owned)
  h.set.mockReset()
  h.accept.mockReset().mockResolvedValue({ accepted: true })
  h.status.mockReset().mockResolvedValue({ claude_bypass_accepted: true })
  h.canControl = true
})
afterEach(cleanup)

describe('the permission-mode chip', () => {
  it('switches in the session by Shift+Tab and shows the mode the daemon read back', async () => {
    h.set.mockResolvedValue({ ...owned, mode: 'plan', source: 'switch' })
    render(<PermissionModeChip sessionId="s1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Permission mode: accept edits/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Plan. Reads and plans; changes nothing' }))
    await waitFor(() => expect(h.set).toHaveBeenCalledWith('s1', 'plan', false))
    expect(await screen.findByRole('button', { name: /Permission mode: plan mode/ })).toBeTruthy()
  })

  it('says where the session ended up when the switch did not get there', async () => {
    h.set.mockRejectedValue(new ApiError(422, 'auto mode is not in this session', { error: 'auto mode is not in this session', code: 'unreachable', mode: 'acceptEdits' }))
    render(<PermissionModeChip sessionId="s1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Permission mode/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Auto/ }))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'auto mode is not in this session')
  })

  it('asks before a restart, and restarts only on the explicit click', async () => {
    h.set.mockResolvedValue({ ...owned, mode: 'bypassPermissions', source: 'launch', in_session: [...owned.in_session!, 'bypassPermissions'], restart: ['dontAsk'] })
    render(<PermissionModeChip sessionId="s1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Permission mode/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Restart in Bypass/ }))
    expect(h.set).not.toHaveBeenCalled()
    expect(screen.getByText(/same conversation is resumed in a new one/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    await waitFor(() => expect(h.set).toHaveBeenCalledWith('s1', 'bypassPermissions', true))
    expect(h.accept).not.toHaveBeenCalled()
  })

  it('shows the one-time bypass warning before the first bypass restart, and records it on accept', async () => {
    h.status.mockResolvedValue({ claude_bypass_accepted: false })
    h.set.mockResolvedValue({ ...owned, mode: 'bypassPermissions' })
    render(<PermissionModeChip sessionId="s1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Permission mode/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Restart in Bypass/ }))
    expect(await screen.findByRole('note', { name: 'Bypass consent' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Accept and restart' }))
    await waitFor(() => expect(h.set).toHaveBeenCalledWith('s1', 'bypassPermissions', true))
    expect(h.accept).toHaveBeenCalled()
  })

  it('offers no restart while the agent works, and nothing while it asks', async () => {
    h.mode.mockResolvedValue({ ...owned, waiting: 'turn' })
    const { unmount } = render(<PermissionModeChip sessionId="s1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Permission mode/ }))
    expect((screen.getByRole('menuitem', { name: /Restart in Bypass/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('menuitemradio', { name: /Plan/ }) as HTMLButtonElement).disabled).toBe(false)
    unmount()
    h.mode.mockResolvedValue({ ...owned, waiting: 'permission' })
    render(<PermissionModeChip sessionId="s1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Permission mode/ }))
    expect(screen.getByText(/answer it first/)).toBeTruthy()
    expect((screen.getByRole('menuitemradio', { name: /Plan/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('is read-only for a session Caprock did not start, and says where to change it', async () => {
    h.mode.mockResolvedValue({ session_id: 's1', mode: 'plan', source: 'hook', switchable: false })
    render(<PermissionModeChip sessionId="s1" />)
    const chip = await screen.findByText('plan mode')
    expect(chip.getAttribute('title')).toMatch(/Shift\+Tab there/)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows nothing for another agent, and asks the daemon nothing', async () => {
    const { container } = render(<PermissionModeChip sessionId="s1" agent="codex" />)
    await Promise.resolve()
    expect(container.textContent).toBe('')
    expect(h.mode).not.toHaveBeenCalled()
  })

  it('draws each mode as a name and what it does, the current one marked, and why a row is off', async () => {
    h.mode.mockResolvedValue({ ...owned, waiting: 'turn' })
    render(<PermissionModeChip sessionId="s1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Permission mode/ }))
    const menu = screen.getByRole('menu', { name: 'Permission mode' })
    expect(menu.textContent).toMatch(/Switch now \(Shift\+Tab\)/)
    expect(menu.textContent).toMatch(/Needs a restart/)
    const plan = menu.querySelector('[data-mode-row="plan"]')!
    expect(plan.querySelector('[data-mode-name]')?.textContent).toBe('Plan')
    expect(plan.querySelector('[data-mode-desc]')?.textContent).toBe('Reads and plans; changes nothing')
    const current = screen.getByRole('menuitemradio', { checked: true })
    expect(current.getAttribute('data-mode-row')).toBe('acceptEdits')
    expect(current.className).toMatch(/border-accent/)
    expect(plan.className).not.toMatch(/border-accent/)
    const bypass = menu.querySelector('[data-mode-row="bypassPermissions"]') as HTMLButtonElement
    expect(bypass.disabled).toBe(true)
    expect(bypass.querySelector('[data-mode-reason]')?.textContent).toMatch(/agent is working/)
    expect(bypass.querySelector('[data-mode-reason]')?.className).toMatch(/text-fg-muted/)
  })
})
