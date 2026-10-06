/**
 * Buttons for a Claude Code permission prompt (ADR-035): what is being asked,
 * one button per answer, and gone the moment something answers it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '@/lib/live'
import { PermissionPrompt } from './PermissionPrompt'

const h = vi.hoisted(() => ({
  permission: vi.fn(),
  answer: vi.fn(),
  canControl: true,
  subs: new Set<(f: Frame) => void>(),
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, permission: h.permission, answerPermission: h.answer } }
})
vi.mock('@/lib/live', () => ({
  useLive: () => ({ conn: 'open', lastFrameAt: 0, tick: 0, alerts: [] }),
  live: { onFrame: (fn: (f: Frame) => void) => { h.subs.add(fn); return () => { h.subs.delete(fn) } } },
}))
vi.mock('@/lib/useCanControl', () => ({ useCanControl: () => h.canControl }))

const bash = { id: 'p1', tool: 'Bash', detail: 'python3 -c "print(1)"', always: 'Yes, and don’t ask again', since: '' }
const frame = (permission: typeof bash | null): Frame => ({ type: 'permission', data: { session_id: 's1', permission } })

beforeEach(() => {
  h.permission.mockReset().mockResolvedValue({ permission: bash })
  h.answer.mockReset().mockResolvedValue(undefined)
  h.canControl = true
})
afterEach(cleanup)

describe('a permission prompt', () => {
  it('shows the tool and the command, with Yes, the offered second option and No', async () => {
    render(<PermissionPrompt sessionId="s1" />)
    expect(await screen.findByText('python3 -c "print(1)"')).toBeTruthy()
    expect(screen.getByText('Bash')).toBeTruthy()
    for (const name of ['Yes', 'Yes, and don’t ask again', 'No']) expect(screen.getByRole('button', { name })).toBeTruthy()
  })

  it.each([['Yes', 'allow'], ['Yes, and don’t ask again', 'always'], ['No', 'deny']])('%s answers %s for this prompt and goes away', async (name, choice) => {
    render(<PermissionPrompt sessionId="s1" />)
    fireEvent.click(await screen.findByRole('button', { name }))
    await waitFor(() => expect(h.answer).toHaveBeenCalledWith('s1', 'p1', choice))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('says Enter in the terminal answers it, and never takes the keyboard from the terminal', async () => {
    const term = document.createElement('textarea')
    document.body.appendChild(term)
    term.focus()
    render(<PermissionPrompt sessionId="s1" />)
    expect(await screen.findByText(/Enter in the terminal = Yes/)).toBeTruthy()
    expect(document.activeElement).toBe(term)
    term.remove()
  })

  it('is one card per prompt: a replacing frame swaps it, never adds a second', async () => {
    render(<PermissionPrompt sessionId="s1" />)
    await screen.findByRole('alertdialog')
    act(() => h.subs.forEach((s) => s(frame({ ...bash, id: 'p2', detail: 'ls' }))))
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1)
    expect(screen.getByText('ls')).toBeTruthy()
  })

  it('offers no second option when Claude Code has none', async () => {
    h.permission.mockResolvedValue({ permission: { ...bash, always: undefined } })
    render(<PermissionPrompt sessionId="s1" />)
    await screen.findByRole('button', { name: 'Yes' })
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('comes and goes with the live frames, and ignores other sessions', async () => {
    h.permission.mockResolvedValue({ permission: null })
    render(<PermissionPrompt sessionId="s1" />)
    await waitFor(() => expect(h.permission).toHaveBeenCalled())
    expect(screen.queryByRole('alertdialog')).toBeNull()
    act(() => h.subs.forEach((s) => s({ type: 'permission', data: { session_id: 's2', permission: bash } })))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    act(() => h.subs.forEach((s) => s(frame(bash))))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    act(() => h.subs.forEach((s) => s(frame(null))))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('shows a viewer what is asked, without buttons', async () => {
    h.canControl = false
    render(<PermissionPrompt sessionId="s1" />)
    await screen.findByText('python3 -c "print(1)"')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
  it('never queues an answer: offline, it fails where it was pressed and is not sent later', async () => {
    // WP-13: a Yes held while offline and sent a minute later could answer a
    // different prompt. It fails on the spot, says so, and nothing retries it.
    h.answer.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<PermissionPrompt sessionId="s1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Yes' }))
    await waitFor(() => expect(h.answer).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    await new Promise((r) => setTimeout(r, 300))
    expect(h.answer).toHaveBeenCalledTimes(1)
  })
})
