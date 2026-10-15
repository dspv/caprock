/**
 * Quick replies: one click sends the reply's exact text through the
 * composer's path (the message queue), the row is the daemon's list, and
 * nothing is drawn while it is empty. Which panes get the row (only sessions
 * Caprock started) is TerminalTabs.test.tsx's.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickReplies } from './QuickReplies'
import { QuickRepliesSetting } from './QuickRepliesSetting'
import { api, type Settings } from '@/lib/api'
import { resetQuickReplies } from '@/lib/quickReplies'

const LIST = [
  { label: 'Continue', text: 'Continue.' },
  { label: 'Shorter', text: 'Shorter, please: say it in fewer words.' },
  { label: 'Run tests', text: 'Run the tests and fix what fails.' },
]

beforeEach(() => { vi.restoreAllMocks(); resetQuickReplies() })
afterEach(() => resetQuickReplies())

describe('QuickReplies', () => {
  it('draws the daemon’s list and sends the exact text of the one clicked through the queue', async () => {
    vi.spyOn(api, 'settings').mockResolvedValue({ quick_replies: LIST } as Settings)
    const send = vi.spyOn(api, 'queueSend').mockResolvedValue({ queue: { messages: [] } } as unknown as Awaited<ReturnType<typeof api.queueSend>>)
    render(<QuickReplies sessionId="s1" />)
    const row = await screen.findByRole('group', { name: 'Quick replies' })
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Continue', 'Shorter', 'Run tests'])
    await act(async () => { fireEvent.click(screen.getByText('Shorter')) })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('s1', 'Shorter, please: say it in fewer words.')
    await waitFor(() => expect(row.querySelector('[data-quick-reply="Shorter"]')).toHaveAttribute('data-state', 'sent'))
  })

  it('says it was not sent when the daemon refuses', async () => {
    resetQuickReplies(LIST)
    vi.spyOn(api, 'queueSend').mockRejectedValue(new Error('not a session Caprock started'))
    render(<QuickReplies sessionId="s1" />)
    await act(async () => { fireEvent.click(screen.getByText('Continue')) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Not sent: not a session Caprock started')
  })

  it('uses the caller’s send when given one (the chat’s)', async () => {
    resetQuickReplies(LIST)
    const queue = vi.spyOn(api, 'queueSend')
    const onSend = vi.fn().mockResolvedValue(true)
    render(<QuickReplies sessionId="s1" onSend={onSend} />)
    await act(async () => { fireEvent.click(screen.getByText('Run tests')) })
    expect(onSend).toHaveBeenCalledWith('Run the tests and fix what fails.')
    expect(queue).not.toHaveBeenCalled()
  })

  it('draws nothing while the list is empty', () => {
    resetQuickReplies([])
    const { container } = render(<QuickReplies sessionId="s1" />)
    expect(container.textContent).toBe('')
  })
})

describe('QuickRepliesSetting', () => {
  it('removes and reorders, saving the whole list to the daemon, and every row follows', async () => {
    resetQuickReplies(LIST)
    const save = vi.spyOn(api, 'saveSettings').mockImplementation(async (s) => s)
    render(<><QuickRepliesSetting /><QuickReplies sessionId="s1" /></>)
    fireEvent.click(screen.getByLabelText('Move Run tests up'))
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ quick_replies: [LIST[0], LIST[2], LIST[1]] }))
    fireEvent.click(screen.getByLabelText('Remove Continue'))
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ quick_replies: [LIST[2], LIST[1]] }))
    const row = screen.getByRole('group', { name: 'Quick replies' })
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Run tests', 'Shorter'])
  })

  it('adds a reply once both its fields are filled in', async () => {
    resetQuickReplies(LIST)
    const save = vi.spyOn(api, 'saveSettings').mockImplementation(async (s) => s)
    render(<QuickRepliesSetting />)
    fireEvent.click(screen.getByText('Add a reply'))
    const label = screen.getByLabelText('Reply 4: label')
    fireEvent.change(label, { target: { value: 'Lint' } })
    fireEvent.blur(label)
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ quick_replies: LIST }))
    const text = screen.getByLabelText('Reply 4: text')
    fireEvent.change(text, { target: { value: '  Run the linter.  ' } })
    fireEvent.blur(text)
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ quick_replies: [...LIST, { label: 'Lint', text: 'Run the linter.' }] }))
  })
})
