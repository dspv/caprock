import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TerminalKeys } from './TerminalKeys'

/** A finger for a pointer, as on a phone or a tablet; or a mouse. */
function touch(on: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('pointer: coarse'), media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList)
}

describe('TerminalKeys — the keyboard on a touch screen', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('Return is a new line and Send sends; the keyboard is told so', () => {
    touch(true)
    const send = vi.fn()
    render(<TerminalKeys send={send} />)
    const field = screen.getByLabelText('Type to the session') as HTMLTextAreaElement
    expect(field.getAttribute('enterkeyhint')).toBe('enter')
    fireEvent.change(field, { target: { value: 'first' } })
    // Not prevented: the browser puts the line break in.
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(true)
    expect(send).not.toHaveBeenCalled()
    // A tablet's keyboard: ⌘/Ctrl+Return sends.
    expect(fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })).toBe(false)
    expect(send).toHaveBeenCalledWith('first')
  })

  it('a desktop keeps Return to send, and has no hide button', () => {
    touch(false)
    const send = vi.fn()
    render(<TerminalKeys send={send} />)
    const field = screen.getByLabelText('Type to the session') as HTMLTextAreaElement
    expect(field.getAttribute('enterkeyhint')).toBeNull()
    act(() => field.focus())
    expect(screen.queryByRole('button', { name: 'Hide the keyboard' })).toBeNull()
    fireEvent.change(field, { target: { value: 'hello' } })
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false)
    expect(send).toHaveBeenCalledWith('hello')
    // The field keeps the focus after a send, as it always did.
    expect(document.activeElement).toBe(field)
  })

  it('the keyboard goes down after Send, and a button puts it away while it is up', () => {
    touch(true)
    render(<TerminalKeys send={vi.fn()} />)
    const field = screen.getByLabelText('Type to the session') as HTMLTextAreaElement
    expect(screen.queryByRole('button', { name: 'Hide the keyboard' })).toBeNull()
    act(() => field.focus())
    fireEvent.click(screen.getByRole('button', { name: 'Hide the keyboard' }))
    expect(document.activeElement).not.toBe(field)
    expect(screen.queryByRole('button', { name: 'Hide the keyboard' })).toBeNull()
    act(() => field.focus())
    fireEvent.change(field, { target: { value: 'go' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(document.activeElement).not.toBe(field)
  })
})
