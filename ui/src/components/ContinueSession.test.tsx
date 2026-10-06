/**
 * A session Caprock started whose terminal closed when Caprock restarted
 * (ADR-033: one from before sessions outlived restarts, or one whose terminal
 * holder died). The owner could not tell what the old panel meant or what its
 * "branch here" would do. Continue is the answer: same conversation, same id,
 * a new terminal. A copy is the second choice and says what it leaves behind.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContinueSession } from './ContinueSession'

const h = vi.hoisted(() => ({
  spawn: vi.fn(async () => ({ session_id: 'new-1', cwd: '/r' })),
  navigate: vi.fn(),
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, isPairedDevice: () => false, api: { ...actual.api, spawn: h.spawn } }
})
vi.mock('@/lib/router', () => ({ navigate: h.navigate }))

const ok = { ok: true, command: 'cd "/r" && claude --resume s1' }

beforeEach(() => {
  h.spawn.mockClear()
  h.navigate.mockClear()
})

/**
 * The owner runs Claude Code with permissions skipped. Continuing a session
 * from Caprock used to start the copy in the default mode, which then asked
 * before every command. The daemon now carries the mode the session was last
 * in; the button says which, and it can be changed before the click.
 */
describe('the permission mode a continue starts in', () => {
  const bypass = { ...ok, permission_mode: 'bypassPermissions' }

  it('is said beside the button and sent with the continue', async () => {
    render(<ContinueSession sessionID="s1" cwd="/r" live={false} resume={bypass} />)
    const picker = screen.getByLabelText<HTMLSelectElement>('Permission mode')
    expect(picker.value).toBe('bypassPermissions')
    expect(picker.selectedOptions[0]!.textContent).toMatch(/Bypass/)
    fireEvent.click(screen.getByRole('button', { name: 'continue here' }))
    await waitFor(() => expect(h.spawn).toHaveBeenCalledWith({ cwd: '/r', resume: 's1', fork: false, permission_mode: 'bypassPermissions' }))
  })

  it('can be changed before continuing', async () => {
    render(<ContinueSession sessionID="s1" cwd="/r" live={false} resume={bypass} />)
    fireEvent.change(screen.getByLabelText('Permission mode'), { target: { value: 'plan' } })
    fireEvent.click(screen.getByRole('button', { name: 'continue here' }))
    await waitFor(() => expect(h.spawn).toHaveBeenCalledWith(expect.objectContaining({ permission_mode: 'plan' })))
  })

  it('keeps a mode the dialog does not list', () => {
    render(<ContinueSession sessionID="s1" cwd="/r" live={false} resume={{ ...ok, permission_mode: 'auto' }} />)
    expect(screen.getByLabelText<HTMLSelectElement>('Permission mode').value).toBe('auto')
  })

  it('sends no mode when none was recorded, leaving the agent its default', async () => {
    render(<ContinueSession sessionID="s1" cwd="/r" live={false} resume={ok} />)
    expect(screen.getByLabelText<HTMLSelectElement>('Permission mode').value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'continue here' }))
    await waitFor(() => expect(h.spawn).toHaveBeenCalledWith({ cwd: '/r', resume: 's1', fork: false }))
  })

  it('is named on a card, which has no room for a picker', () => {
    render(<ContinueSession sessionID="s1" cwd="/r" live={false} resume={bypass} compact />)
    expect(document.body.textContent).toMatch(/bypass permissions/)
    expect(screen.queryByLabelText('Permission mode')).toBeNull()
  })
})

describe('a session whose terminal closed when Caprock restarted', () => {
  it('leads with Continue it here, which resumes the same conversation', async () => {
    render(<ContinueSession sessionID="s1" cwd="/r" live={false} detached resume={ok} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue it here' }))
    await waitFor(() => expect(h.spawn).toHaveBeenCalledWith({ cwd: '/r', resume: 's1', fork: false }))
    expect(h.navigate).toHaveBeenCalledWith({ name: 'session', id: 'new-1', tab: 'terminal' })
  })

  it('offers a copy second, and says the old process is left running', async () => {
    render(<ContinueSession sessionID="s1" cwd="/r" live={false} detached resume={ok} />)
    expect(document.body.textContent).toMatch(/old process is left running/)
    fireEvent.click(screen.getByRole('button', { name: 'open a copy instead' }))
    await waitFor(() => expect(h.spawn).toHaveBeenCalledWith({ cwd: '/r', resume: 's1', fork: true }))
  })

  it('keeps the command for a terminal of your own', () => {
    render(<ContinueSession sessionID="s1" cwd="/r" live={false} detached resume={ok} />)
    expect(screen.getByRole('button', { name: 'copy command' })).toBeTruthy()
  })

  it('never says branch or fork', () => {
    render(<ContinueSession sessionID="s1" cwd="/r" live={false} detached resume={ok} />)
    expect(document.body.textContent).not.toMatch(/branch|fork/i)
  })
})
