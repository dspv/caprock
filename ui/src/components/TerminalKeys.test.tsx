import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TerminalKeys } from './TerminalKeys'

describe('TerminalKeys — typing from a phone', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('sends the keys a phone keyboard does not have, as a terminal encodes them', () => {
    const send = vi.fn()
    render(<TerminalKeys send={send} />)
    for (const [name, bytes] of [
      [/^Escape/, '\x1b'], [/^Tab/, '\t'], [/^Up/, '\x1b[A'], [/^Down/, '\x1b[B'], [/^Enter/, '\r'], [/^Ctrl\+C/, '\x03'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }))
      expect(send).toHaveBeenLastCalledWith(bytes)
    }
  })

  // The text and the Enter go separately: in one write a TUI reads the pair as
  // a paste and keeps the Enter as a new line instead of submitting.
  it('sends the text, then Enter on its own; a line break inside is ESC CR', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    render(<TerminalKeys send={send} />)
    const field = screen.getByLabelText('Type to the session')
    fireEvent.change(field, { target: { value: 'first\nsecond' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith('first\x1b\rsecond')
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('\r')
    expect((field as HTMLTextAreaElement).value).toBe('')
  })

  it('Send on an empty field is Enter', () => {
    const send = vi.fn()
    render(<TerminalKeys send={send} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledWith('\r')
  })
})

describe('TerminalKeys — attaching a photo', () => {
  afterEach(cleanup)

  it('has no photo button where nothing can attach one', () => {
    render(<TerminalKeys send={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Attach a photo' })).toBeNull()
  })

  it('opens the picker for images, from the camera or the library, and attaches what is picked', async () => {
    const attach = vi.fn(async () => {})
    render(<TerminalKeys send={vi.fn()} attach={attach} />)
    const picker = screen.getByTestId('photo-picker') as HTMLInputElement
    expect(picker.accept).toBe('image/*')
    // `capture` would make iOS open the camera only, with no library.
    expect(picker.hasAttribute('capture')).toBe(false)
    const click = vi.spyOn(picker, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Attach a photo' }))
    expect(click).toHaveBeenCalled()
    const photo = new File(['x'], 'IMG_0001.jpg', { type: 'image/jpeg' })
    fireEvent.change(picker, { target: { files: [photo] } })
    await vi.waitFor(() => expect(attach).toHaveBeenCalledWith([photo]))
  })

  // The Changes tab's "Ask the agent" arrives with the start of a message.
  it('starts from a draft, focused, ready to finish', () => {
    render(<TerminalKeys send={vi.fn()} initial="In a.ts around line 5: " />)
    const field = screen.getByLabelText('Type to the session') as HTMLTextAreaElement
    expect(field.value).toBe('In a.ts around line 5: ')
    expect(document.activeElement).toBe(field)
  })

  // Idle it is one line, so the bar does not push the terminal up for nothing.
  it('starts one line tall', () => {
    render(<TerminalKeys send={vi.fn()} />)
    expect((screen.getByLabelText('Type to the session') as HTMLTextAreaElement).rows).toBe(1)
  })
})

describe('TerminalKeys — the offline queue (WP-13)', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    sessionStorage.clear()
  })

  const type = (text: string) => {
    fireEvent.change(screen.getByLabelText('Type to the session'), { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  }

  it('holds a message typed while offline, shows it, and sends it on reconnect when nothing waits', async () => {
    const send = vi.fn()
    const isPromptWaiting = vi.fn(async () => false)
    const { rerender } = render(<TerminalKeys send={send} state="reconnecting" isPromptWaiting={isPromptWaiting} />)
    type('run the tests')
    expect(send).not.toHaveBeenCalled()
    expect(screen.getByText('Will send when connected')).toBeTruthy()
    expect(screen.getByText('run the tests')).toBeTruthy()
    rerender(<TerminalKeys send={send} state="catching-up" isPromptWaiting={isPromptWaiting} />)
    expect(send).not.toHaveBeenCalled() // not before it is live
    rerender(<TerminalKeys send={send} state="live" isPromptWaiting={isPromptWaiting} />)
    await waitFor(() => expect(send).toHaveBeenCalledWith('\r'))
    expect(send.mock.calls.map((c) => c[0])).toEqual(['run the tests', '\r'])
    expect(isPromptWaiting).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Will send when connected')).toBeNull()
  })

  it('keeps it as a draft with Send now when a permission prompt waits', async () => {
    const send = vi.fn()
    const { rerender } = render(<TerminalKeys send={send} state="reconnecting" isPromptWaiting={async () => true} />)
    type('yes do it')
    rerender(<TerminalKeys send={send} state="live" isPromptWaiting={async () => true} />)
    expect(await screen.findByText('Not sent — a permission prompt is waiting')).toBeTruthy()
    expect(send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith('\r'))
    expect(send.mock.calls.map((c) => c[0])).toEqual(['yes do it', '\r'])
  })

  it('keeps it as a draft when it cannot tell whether a prompt waits', async () => {
    const send = vi.fn()
    const failing = async () => { throw new Error('network') }
    const { rerender } = render(<TerminalKeys send={send} state="reconnecting" isPromptWaiting={failing} />)
    type('hello')
    rerender(<TerminalKeys send={send} state="live" isPromptWaiting={failing} />)
    expect(await screen.findByText(/^Not sent — /)).toBeTruthy()
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps it as a draft when the session ended, and Send now waits for a connection', () => {
    const send = vi.fn()
    const { rerender } = render(<TerminalKeys send={send} state="reconnecting" />)
    type('hello')
    rerender(<TerminalKeys send={send} state="ended" />)
    expect(screen.getByText('Not sent — the session ended')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Send now' }) as HTMLButtonElement).disabled).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('does not send if the connection drops again while it checks', async () => {
    const send = vi.fn()
    let answer: (v: boolean) => void = () => {}
    const isPromptWaiting = () => new Promise<boolean>((r) => { answer = r })
    const { rerender } = render(<TerminalKeys send={send} state="reconnecting" isPromptWaiting={isPromptWaiting} />)
    type('hello')
    rerender(<TerminalKeys send={send} state="live" isPromptWaiting={isPromptWaiting} />)
    rerender(<TerminalKeys send={send} state="reconnecting" isPromptWaiting={isPromptWaiting} />)
    answer(false)
    await new Promise((r) => setTimeout(r, 200))
    expect(send).not.toHaveBeenCalled()
    expect(screen.getByText('Will send when connected')).toBeTruthy()
  })

  it('never queues a raw key: it is refused, and says so', () => {
    const send = vi.fn()
    render(<TerminalKeys send={send} state="reconnecting" />)
    fireEvent.click(screen.getByRole('button', { name: /^Escape/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Ctrl\+C/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' })) // Enter, on an empty field
    expect(send).not.toHaveBeenCalled()
    expect(screen.getByText(/Not connected — Enter was not sent\. Keys are never queued\./)).toBeTruthy()
  })

  it('keeps held messages across a reload of the page', () => {
    const send = vi.fn()
    render(<TerminalKeys send={send} state="reconnecting" sessionId="s1" />)
    type('survive me')
    cleanup()
    render(<TerminalKeys send={send} state="reconnecting" sessionId="s1" />)
    expect(screen.getByText('survive me')).toBeTruthy()
    // Another session's bar does not show it.
    cleanup()
    render(<TerminalKeys send={send} state="reconnecting" sessionId="s2" />)
    expect(screen.queryByText('survive me')).toBeNull()
  })

  it('Edit puts a held message back in the field', () => {
    render(<TerminalKeys send={vi.fn()} state="reconnecting" />)
    type('change me')
    fireEvent.click(screen.getByRole('button', { name: 'Edit the message: change me' }))
    expect((screen.getByLabelText('Type to the session') as HTMLTextAreaElement).value).toBe('change me')
    expect(screen.queryByText('Will send when connected')).toBeNull()
  })
})
