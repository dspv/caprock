import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
})
