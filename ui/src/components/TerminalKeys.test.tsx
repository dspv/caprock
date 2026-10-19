import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  // The chat's attach returns the saved paths rather than typing them: each
  // is an "Image N" chip over the field, never the path in the text (owner's
  // phone, 2026-10-18: a line of "/Users/…/Application Support/…" in the field).
  it('shows each attached photo as an Image N chip, never its path in the field', async () => {
    const attach = vi.fn(async () => ['/data/paste/IMG 1.jpg', '/data/paste/IMG_2.jpg'])
    const send = vi.fn()
    render(<TerminalKeys send={send} attach={attach} sendPaths={vi.fn(async () => {})} />)
    const field = screen.getByLabelText('Type to the session') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'look at' } })
    fireEvent.change(screen.getByTestId('photo-picker'), { target: { files: [new File(['x'], 'a.jpg', { type: 'image/jpeg' }), new File(['y'], 'b.jpg', { type: 'image/jpeg' })] } })
    const chips = await screen.findByRole('list', { name: 'Attached photos' })
    expect(chips.textContent).toContain('Image 1')
    expect(chips.textContent).toContain('Image 2')
    expect(field.value).toBe('look at')
    expect(document.body.textContent).not.toContain('/data/paste')
    expect(send).not.toHaveBeenCalled()
  })

  it('the × on a chip takes that photo out, and the rest renumber', async () => {
    const attach = vi.fn(async () => ['/p/one.jpg', '/p/two.jpg'])
    const sendPaths = vi.fn(async () => {})
    const submitText = vi.fn(async () => true)
    render(<TerminalKeys send={vi.fn()} attach={attach} sendPaths={sendPaths} submitText={submitText} />)
    fireEvent.change(screen.getByTestId('photo-picker'), { target: { files: [new File(['x'], 'a.jpg'), new File(['y'], 'b.jpg')] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Image 1' }))
    expect(screen.queryByRole('button', { name: 'Remove Image 2' })).toBeNull()
    expect(screen.getByRole('list', { name: 'Attached photos' }).textContent).toContain('Image 1')
    fireEvent.change(screen.getByLabelText('Type to the session'), { target: { value: 'this one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await vi.waitFor(() => expect(submitText).toHaveBeenCalledWith('this one'))
    expect(sendPaths).toHaveBeenCalledWith(['/p/two.jpg'])
    expect(screen.queryByRole('list', { name: 'Attached photos' })).toBeNull()
  })

  it('on Send the photos are pasted first, in order, then the words go', async () => {
    const order: string[] = []
    const attach = vi.fn(async () => ['/p/1.png', '/p/2.png'])
    const sendPaths = vi.fn(async (paths: readonly string[]) => { order.push(`paths:${paths.join(',')}`) })
    const submitText = vi.fn(async (t: string) => { order.push(`text:${t}`); return true })
    render(<TerminalKeys send={vi.fn()} attach={attach} sendPaths={sendPaths} submitText={submitText} />)
    fireEvent.change(screen.getByTestId('photo-picker'), { target: { files: [new File(['x'], 'a.png'), new File(['y'], 'b.png')] } })
    await screen.findByRole('list', { name: 'Attached photos' })
    fireEvent.change(screen.getByLabelText('Type to the session'), { target: { value: 'help me answer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await vi.waitFor(() => expect(order).toEqual(['paths:/p/1.png,/p/2.png', 'text:help me answer']))
  })

  it('photos with no words are pasted, then Enter', async () => {
    const send = vi.fn()
    const sendPaths = vi.fn(async () => {})
    const submitText = vi.fn(async () => true)
    render(<TerminalKeys send={send} attach={vi.fn(async () => ['/p/1.jpg'])} sendPaths={sendPaths} submitText={submitText} />)
    fireEvent.change(screen.getByTestId('photo-picker'), { target: { files: [new File(['x'], 'a.jpg')] } })
    await screen.findByRole('list', { name: 'Attached photos' })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('\r'))
    expect(sendPaths).toHaveBeenCalledWith(['/p/1.jpg'])
    expect(submitText).not.toHaveBeenCalled()
  })

  it('a photo held while offline keeps its chip: shown as [Image 1], back as a chip on Edit', async () => {
    const sendPaths = vi.fn(async () => {})
    render(<TerminalKeys send={vi.fn()} state="reconnecting" sessionId="chip" attach={vi.fn(async () => ['/p/1.jpg'])} sendPaths={sendPaths} />)
    fireEvent.change(screen.getByTestId('photo-picker'), { target: { files: [new File(['x'], 'a.jpg')] } })
    await screen.findByRole('list', { name: 'Attached photos' })
    fireEvent.change(screen.getByLabelText('Type to the session'), { target: { value: 'see' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByText('[Image 1] see')).toBeTruthy()
    // Across a reload, too.
    cleanup()
    render(<TerminalKeys send={vi.fn()} state="reconnecting" sessionId="chip" attach={vi.fn()} sendPaths={sendPaths} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit the message: [Image 1] see' }))
    expect((screen.getByLabelText('Type to the session') as HTMLTextAreaElement).value).toBe('see')
    expect(screen.getByRole('list', { name: 'Attached photos' }).textContent).toContain('Image 1')
    expect(sendPaths).not.toHaveBeenCalled()
    sessionStorage.clear()
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

  it('a message sent after the session ended is a draft at once, never "will send"', () => {
    const send = vi.fn()
    render(<TerminalKeys send={send} state="ended" />)
    type('too late')
    expect(screen.getByText('Not sent — the session ended')).toBeTruthy()
    expect(screen.queryByText('Will send when connected')).toBeNull()
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

describe('TerminalKeys — the phone chat: voice and folded keys', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
  })

  it('keeps the raw keys behind a Keys button when folded', () => {
    render(<TerminalKeys send={vi.fn()} foldKeys />)
    expect(screen.queryByRole('button', { name: /^Escape/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Keys' }))
    expect(screen.getByRole('button', { name: /^Escape/ })).toBeTruthy()
  })

  it('says in one line how to dictate when the page is plain http', () => {
    ;(window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = class {}
    vi.stubGlobal('isSecureContext', false)
    render(<TerminalKeys send={vi.fn()} voice />)
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    expect(screen.getByRole('status').textContent).toMatch(/https.*keyboard/)
  })

  it('shows what is heard in the field, after what was typed, and sends nothing by itself', () => {
    let rec: { onresult?: (e: unknown) => void; onend?: () => void } = {}
    ;(window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = class {
      onresult?: (e: unknown) => void
      onend?: () => void
      constructor() { rec = this }
      start() {}
      stop() { this.onend?.() }
    }
    vi.stubGlobal('isSecureContext', true)
    const submitText = vi.fn()
    render(<TerminalKeys send={vi.fn()} submitText={submitText} voice />)
    const field = screen.getByLabelText('Type to the session') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'Next:' } })
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    expect(screen.getByRole('status').textContent).toMatch(/Listening/)
    act(() => rec.onresult?.({ results: [{ isFinal: false, 0: { transcript: 'fix the test' } }] }))
    expect(field.value).toBe('Next: fix the test')
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictating' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(field.value).toBe('Next: fix the test')
    expect(submitText).not.toHaveBeenCalled()
  })

  it('Send while it listens waits for the last words, sends them once, and drops none', async () => {
    let rec: { onresult?: (e: unknown) => void; onend?: () => void } = {}
    ;(window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = class {
      onresult?: (e: unknown) => void
      onend?: () => void
      constructor() { rec = this }
      start() {}
      stop() {}
    }
    vi.stubGlobal('isSecureContext', true)
    const submitText = vi.fn(async () => true)
    render(<TerminalKeys send={vi.fn()} submitText={submitText} voice />)
    const field = screen.getByLabelText('Type to the session') as HTMLTextAreaElement
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    act(() => rec.onresult?.({ results: [{ isFinal: false, 0: { transcript: 'rerun the' } }] }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(submitText).not.toHaveBeenCalled()
    // The final result arrives after stop(), then the end.
    act(() => rec.onresult?.({ results: [{ isFinal: true, 0: { transcript: 'rerun the failing job' } }] }))
    act(() => rec.onend?.())
    await waitFor(() => expect(submitText).toHaveBeenCalledWith('rerun the failing job'))
    expect(submitText).toHaveBeenCalledTimes(1)
    expect(field.value).toBe('')
  })

  it('dictates in the language on the chip, and a tap past the browser languages opens the list', () => {
    localStorage.clear()
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
    let rec: { lang?: string } = {}
    ;(window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = class {
      lang = ''
      constructor() { rec = this }
      start() {}
      stop() {}
    }
    vi.stubGlobal('isSecureContext', true)
    render(<TerminalKeys send={vi.fn()} voice />)
    const chip = screen.getByTestId('speech-lang')
    expect(chip.textContent).toBe('EN')
    // One browser language: the tap opens the list rather than doing nothing.
    fireEvent.click(chip)
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Russian/ }))
    expect(chip.textContent).toBe('RU')
    expect(localStorage.getItem('caprock.speech.lang')).toBe('ru-RU')
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    expect(rec.lang).toBe('ru-RU')
    vi.restoreAllMocks()
  })

  it('introduces the chip once to a browser with two languages, and a tap switches', () => {
    localStorage.clear()
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US', 'ru'])
    ;(window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = class {}
    render(<TerminalKeys send={vi.fn()} voice />)
    expect(screen.getByRole('status').textContent).toMatch(/listens for English/)
    fireEvent.click(screen.getByTestId('speech-lang'))
    expect(screen.getByTestId('speech-lang').textContent).toBe('RU')
    expect(screen.queryByRole('status')).toBeNull()
    expect(localStorage.getItem('caprock.speech.langSeen')).toBe('1')
    vi.restoreAllMocks()
  })
})
