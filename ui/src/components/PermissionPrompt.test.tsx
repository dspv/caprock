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

  it('hides a prompt that no longer waits, typing nothing', async () => {
    render(<PermissionPrompt sessionId="s1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Hide this prompt' }))
    await waitFor(() => expect(h.answer).toHaveBeenCalledWith('s1', 'p1', 'dismiss'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it.each([['Yes', 'allow'], ['Yes, and don’t ask again', 'always'], ['No', 'deny']])('%s answers %s for this prompt and goes away', async (name, choice) => {
    render(<PermissionPrompt sessionId="s1" />)
    fireEvent.click(await screen.findByRole('button', { name }))
    await waitFor(() => expect(h.answer).toHaveBeenCalledWith('s1', 'p1', choice))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  describe('keys', () => {
    const press = (key: string, target: Element = document.body) => fireEvent.keyDown(target, { key })

    it.each([['y', 'allow'], ['Y', 'allow'], ['Enter', 'allow'], ['a', 'always'], ['n', 'deny'], ['Escape', 'deny']])('%s answers %s', async (key, choice) => {
      render(<PermissionPrompt sessionId="s1" />)
      await screen.findByRole('alertdialog')
      press(key)
      await waitFor(() => expect(h.answer).toHaveBeenCalledWith('s1', 'p1', choice))
    })

    it('shows each key on its button, outside the button name', async () => {
      render(<PermissionPrompt sessionId="s1" />)
      const yes = await screen.findByRole('button', { name: 'Yes' })
      expect(yes.textContent).toContain('Y')
      expect(screen.getByRole('button', { name: 'Yes, and don’t ask again' }).textContent).toContain('A')
      expect(screen.getByRole('button', { name: 'No' }).textContent).toContain('N')
    })

    // The owner lives in the terminal (2026-10-07): the card's letters answer
    // from the asking session's own terminal, and never reach it.
    it.each([['y', 'allow'], ['a', 'always'], ['n', 'deny']])('%s from the asking session’s terminal answers %s and never reaches it', async (key, choice) => {
      render(<PermissionPrompt sessionId="s1" />)
      await screen.findByRole('alertdialog')
      const host = document.createElement('div')
      host.className = 'xterm'
      host.setAttribute('data-term-session', 's1')
      const term = document.createElement('textarea')
      host.appendChild(term)
      document.body.append(host)
      const typed = vi.fn()
      term.addEventListener('keydown', typed)
      term.focus()
      press(key, term)
      await waitFor(() => expect(h.answer).toHaveBeenCalledWith('s1', 'p1', choice))
      expect(typed).not.toHaveBeenCalled()
      host.remove()
    })

    it('leaves Enter and Esc in its terminal to Claude Code’s own menu', async () => {
      render(<PermissionPrompt sessionId="s1" />)
      await screen.findByRole('alertdialog')
      const host = document.createElement('div')
      host.setAttribute('data-term-session', 's1')
      const term = document.createElement('textarea')
      host.appendChild(term)
      document.body.append(host)
      const typed = vi.fn()
      term.addEventListener('keydown', typed)
      term.focus()
      press('Enter', term)
      press('Escape', term)
      await new Promise((r) => setTimeout(r, 20))
      expect(h.answer).not.toHaveBeenCalled()
      expect(typed).toHaveBeenCalledTimes(2)
      host.remove()
    })

    it('A does nothing when there is no always option', async () => {
      h.permission.mockResolvedValue({ permission: { ...bash, always: undefined } })
      render(<PermissionPrompt sessionId="s1" />)
      await screen.findByRole('alertdialog')
      press('a')
      await new Promise((r) => setTimeout(r, 20))
      expect(h.answer).not.toHaveBeenCalled()
    })

    it('never takes a key from another terminal or a field', async () => {
      render(<PermissionPrompt sessionId="s1" />)
      await screen.findByRole('alertdialog')
      // xterm types through a textarea inside its host.
      const host = document.createElement('div')
      host.className = 'xterm'
      host.setAttribute('data-term-session', 'someone-else')
      const term = document.createElement('textarea')
      host.appendChild(term)
      const field = document.createElement('input')
      document.body.append(host, field)
      for (const el of [term, field]) {
        el.focus()
        for (const key of ['y', 'Enter', 'a', 'n', 'Escape']) press(key, el)
      }
      await new Promise((r) => setTimeout(r, 20))
      expect(h.answer).not.toHaveBeenCalled()
      host.remove()
      field.remove()
    })

    it('leaves Enter and Esc to another focused control, and to an open dialog', async () => {
      render(<PermissionPrompt sessionId="s1" />)
      await screen.findByRole('alertdialog')
      const other = document.createElement('button')
      document.body.appendChild(other)
      other.focus()
      press('Enter', other)
      press('Escape', other)
      other.remove()
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      document.body.appendChild(dialog)
      press('y')
      dialog.remove()
      await new Promise((r) => setTimeout(r, 20))
      expect(h.answer).not.toHaveBeenCalled()
    })

    it('ignores keys with a modifier, and a viewer gets none', async () => {
      const { unmount } = render(<PermissionPrompt sessionId="s1" />)
      await screen.findByRole('alertdialog')
      fireEvent.keyDown(document.body, { key: 'a', metaKey: true })
      fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true })
      unmount()
      h.canControl = false
      render(<PermissionPrompt sessionId="s1" />)
      await screen.findByRole('alertdialog')
      press('y')
      await new Promise((r) => setTimeout(r, 20))
      expect(h.answer).not.toHaveBeenCalled()
    })

    it('a hidden card (a background tab) does not answer', async () => {
      render(<div hidden><PermissionPrompt sessionId="s1" /></div>)
      await waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeTruthy())
      press('y')
      await new Promise((r) => setTimeout(r, 20))
      expect(h.answer).not.toHaveBeenCalled()
    })

    it('two cards on a page: only the newest takes the key', async () => {
      h.permission.mockImplementation(async (id: string) => ({ permission: { ...bash, id: `p-${id}` } }))
      render(<><PermissionPrompt sessionId="s1" /><PermissionPrompt sessionId="s2" /></>)
      await waitFor(() => expect(screen.getAllByRole('alertdialog')).toHaveLength(2))
      press('y')
      await waitFor(() => expect(h.answer).toHaveBeenCalledTimes(1))
      expect(h.answer).toHaveBeenCalledWith('s2', 'p-s2', 'allow')
    })
  })

  it('shows why when the option is not on the screen, and keeps the prompt', async () => {
    const { ApiError } = await import('@/lib/api')
    h.answer.mockRejectedValue(new ApiError(422, 'Unprocessable', { error: 'that option is not on the prompt — answer in the terminal' }))
    render(<PermissionPrompt sessionId="s1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, and don’t ask again' }))
    expect((await screen.findByRole('alert')).textContent).toBe('that option is not on the prompt — answer in the terminal')
    expect(screen.getByRole('alertdialog')).toBeTruthy()
  })

  it('says how many more prompts wait behind this one', async () => {
    h.permission.mockResolvedValue({ permission: { ...bash, queued: 2 } })
    render(<PermissionPrompt sessionId="s1" />)
    expect(await screen.findByText(/2 more waiting/)).toBeTruthy()
  })

  it('says its keys work from the terminal, and never takes the keyboard from it', async () => {
    const term = document.createElement('textarea')
    document.body.appendChild(term)
    term.focus()
    render(<PermissionPrompt sessionId="s1" />)
    expect(await screen.findByText(/Keys work from the terminal/)).toBeTruthy()
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
    // Hide, Yes and No: no second option.
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /don’t ask again/ })).toBeNull()
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
