/**
 * The desktop app's microphone (ADR-102) in the composer and the chat
 * field, with the shell stubbed: hold to talk, click to toggle, the words in
 * the field live and kept, never sent; the errors' lines; hidden where the
 * shell cannot dictate.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  queueSend: vi.fn(),
  queue: vi.fn(),
  savedPrompts: vi.fn(),
  sessionCommands: vi.fn(),
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, ...m } }
})

import { Composer } from './Composer'
import { TerminalKeys } from './TerminalKeys'
import { DICTATION_EVENT, resetDeskVoice } from '@/lib/deskvoice'
import { resetSaved } from '@/lib/saved'
import { resetPickerCache } from './ChatPicker'

let invoke: ReturnType<typeof vi.fn>
let nextId = 1
let supported = true

function emit(detail: Record<string, unknown>) {
  act(() => { window.dispatchEvent(new CustomEvent(DICTATION_EVENT, { detail })) })
}

const view = (over: object = {}) => ({ session_id: 's1', messages: [], waiting: '', ...over })

beforeEach(() => {
  nextId = 1
  supported = true
  resetDeskVoice()
  localStorage.setItem('caprock.speech.lang', 'en-US')
  invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'dictation_status') return supported ? { supported: true } : { supported: false, reason: 'unsupported' }
    if (cmd === 'dictation_start') return nextId++
    if (cmd === 'dictation_stop') return null
    throw new Error(`unexpected ${cmd}`)
  })
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke }
  m.queue.mockResolvedValue(view())
  m.savedPrompts.mockResolvedValue({ items: [], max: 200 })
  m.queueSend.mockResolvedValue({ sent: true, queue: view() })
  m.sessionCommands.mockResolvedValue({ commands: [] })
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  resetSaved()
  resetPickerCache()
  localStorage.clear()
  vi.useRealTimers()
  vi.clearAllMocks()
})

const box = () => screen.getByLabelText('Message Claude') as HTMLTextAreaElement

async function mountComposer() {
  render(<Composer sessionId="s1" agent="claude" asking={false} onBack={vi.fn()} onFiles={vi.fn()} />)
  return screen.findByTestId('desk-mic')
}

describe('voice input in the composer', () => {
  it('hold to talk: partial words show live after what was typed, the release keeps them in the box, nothing is sent', async () => {
    const mic = await mountComposer()
    fireEvent.change(box(), { target: { value: 'Please' } })
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('dictation_start', { lang: 'en-US' }))
    await waitFor(() => expect(mic).toHaveAttribute('data-phase', 'listening'))
    expect(screen.getByRole('status')).toHaveTextContent('Listening in English — release to stop')
    expect(box().readOnly).toBe(true)
    emit({ kind: 'partial', id: 1, text: 'fix the' })
    expect(box().value).toBe('Please fix the')
    expect(mic).toHaveAttribute('data-phase', 'partial')
    emit({ kind: 'partial', id: 1, text: 'fix the parser' })
    expect(box().value).toBe('Please fix the parser')

    now.mockReturnValue(2000) // held a second: hold-to-talk
    fireEvent.pointerUp(mic, { button: 0, pointerId: 1 })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('dictation_stop', { id: 1, cancel: false }))
    expect(screen.getByRole('status')).toHaveTextContent('Finishing…')
    emit({ kind: 'final', id: 1, text: 'fix the parser.' })
    emit({ kind: 'end', id: 1 })
    expect(box().value).toBe('Please fix the parser.')
    expect(box().readOnly).toBe(false)
    expect(mic).toHaveAttribute('data-phase', 'inserted')
    expect(m.queueSend).not.toHaveBeenCalled()
    // Then Enter sends it, as any message.
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(m.queueSend).toHaveBeenCalledWith('s1', 'Please fix the parser.'))
  })

  it('first use: released while macOS asks, it listens once allowed until a click, and says so', async () => {
    const mic = await mountComposer()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
    await waitFor(() => expect(mic).toHaveAttribute('data-phase', 'listening'))
    emit({ kind: 'asking', id: 1 })
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for macOS to allow the microphone and speech recognition for Caprock')
    now.mockReturnValue(4000) // a long hold, released while the prompt is up
    fireEvent.pointerUp(mic, { button: 0, pointerId: 1 })
    expect(invoke).not.toHaveBeenCalledWith('dictation_stop', expect.anything())
    emit({ kind: 'listening', id: 1 })
    expect(screen.getByRole('status')).toHaveTextContent('Listening in English — click the mic to stop')
    emit({ kind: 'partial', id: 1, text: 'first words' })
    expect(box().value).toBe('first words')
    now.mockReturnValue(9000)
    fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
    fireEvent.pointerUp(mic, { button: 0, pointerId: 1 })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('dictation_stop', { id: 1, cancel: false }))
    emit({ kind: 'end', id: 1 })
    expect(box().value).toBe('first words')
    expect(screen.queryByText(/Heard nothing/)).toBeNull()
  })

  it('a long dictation the shell restarts keeps every word and listens until the release', async () => {
    const mic = await mountComposer()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
    await waitFor(() => expect(mic).toHaveAttribute('data-phase', 'listening'))
    emit({ kind: 'partial', id: 1, text: 'First part.' })
    // Apple ended that request; the shell started another, the first kept in front.
    emit({ kind: 'partial', id: 1, text: 'First part. Second part' })
    expect(box().value).toBe('First part. Second part')
    expect(mic).toHaveAttribute('aria-pressed', 'true')
    expect(invoke).not.toHaveBeenCalledWith('dictation_stop', expect.anything())
    now.mockReturnValue(70_000)
    fireEvent.pointerUp(mic, { button: 0, pointerId: 1 })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('dictation_stop', { id: 1, cancel: false }))
    emit({ kind: 'final', id: 1, text: 'First part. Second part.' })
    emit({ kind: 'end', id: 1 })
    expect(box().value).toBe('First part. Second part.')
  })

  it('a click starts it and leaves it listening; the next click stops it', async () => {
    const mic = await mountComposer()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
    now.mockReturnValue(1080)
    fireEvent.pointerUp(mic, { button: 0, pointerId: 1 })
    await waitFor(() => expect(mic).toHaveAttribute('data-phase', 'listening'))
    expect(invoke).not.toHaveBeenCalledWith('dictation_stop', expect.anything())
    expect(screen.getByRole('status')).toHaveTextContent('click the mic to stop')
    emit({ kind: 'partial', id: 1, text: 'hello' })
    now.mockReturnValue(5000)
    fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
    now.mockReturnValue(5050)
    fireEvent.pointerUp(mic, { button: 0, pointerId: 1 })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('dictation_stop', { id: 1, cancel: false }))
    emit({ kind: 'end', id: 1 })
    expect(box().value).toBe('hello')
  })

  it('Enter or Space on the focused mic toggles it', async () => {
    const mic = await mountComposer()
    fireEvent.click(mic, { detail: 0 })
    await waitFor(() => expect(mic).toHaveAttribute('data-phase', 'listening'))
    fireEvent.click(mic, { detail: 0 })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('dictation_stop', { id: 1, cancel: false }))
  })

  it('a refused microphone says where to allow it, and the box keeps what was typed', async () => {
    const mic = await mountComposer()
    fireEvent.change(box(), { target: { value: 'typed' } })
    fireEvent.click(mic, { detail: 0 })
    await waitFor(() => expect(mic).toHaveAttribute('data-phase', 'listening'))
    emit({ kind: 'end', id: 1, error: 'mic-denied' })
    expect(screen.getByRole('status')).toHaveTextContent('Caprock may not use the microphone. Allow it in System Settings → Privacy & Security → Microphone')
    expect(box().value).toBe('typed')
    // Typing clears the line.
    fireEvent.change(box(), { target: { value: 'typed more' } })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a language with no on-device model is refused with the line that names it', async () => {
    localStorage.setItem('caprock.speech.lang', 'uk-UA')
    const mic = await mountComposer()
    fireEvent.click(mic, { detail: 0 })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('dictation_start', { lang: 'uk-UA' }))
    emit({ kind: 'end', id: 1, error: 'on-device-unavailable' })
    expect(screen.getByRole('status')).toHaveTextContent("Ukrainian isn't available on this Mac without sending audio to Apple")
  })

  it('nothing heard says so', async () => {
    const mic = await mountComposer()
    fireEvent.click(mic, { detail: 0 })
    await waitFor(() => expect(mic).toHaveAttribute('data-phase', 'listening'))
    emit({ kind: 'end', id: 1, error: 'no-speech' })
    expect(screen.getByRole('status')).toHaveTextContent('Heard nothing')
  })

  it('Enter while it listens sends what the box shows and stops listening', async () => {
    const mic = await mountComposer()
    fireEvent.click(mic, { detail: 0 })
    await waitFor(() => expect(mic).toHaveAttribute('data-phase', 'listening'))
    emit({ kind: 'partial', id: 1, text: 'ship it' })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(m.queueSend).toHaveBeenCalledWith('s1', 'ship it'))
    expect(invoke).toHaveBeenCalledWith('dictation_stop', { id: 1, cancel: true })
    // Late words do not come back into the emptied box.
    emit({ kind: 'final', id: 1, text: 'ship it now' })
    await waitFor(() => expect(box().value).toBe(''))
  })

  it('a release that the recogniser never answers ends after a few seconds, keeping the words', async () => {
    const mic = await mountComposer()
    fireEvent.click(mic, { detail: 0 })
    await waitFor(() => expect(mic).toHaveAttribute('data-phase', 'listening'))
    emit({ kind: 'partial', id: 1, text: 'almost' })
    vi.useFakeTimers()
    fireEvent.click(mic, { detail: 0 })
    act(() => { vi.advanceTimersByTime(3100) })
    expect(invoke).toHaveBeenCalledWith('dictation_stop', { id: 1, cancel: true })
    expect(mic).toHaveAttribute('data-phase', 'inserted')
    expect(box().value).toBe('almost')
  })

  it('the language chip cycles through the viewer’s languages', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US', 'ru-RU'])
    await mountComposer()
    const chip = screen.getByTestId('desk-voice-lang')
    expect(chip).toHaveTextContent('EN')
    fireEvent.click(chip)
    expect(chip).toHaveTextContent('RU')
    fireEvent.click(chip)
    expect(screen.getByRole('menu', { name: 'Voice input language' })).toBeInTheDocument()
  })

  it('is hidden where the shell cannot dictate, and in a browser tab', async () => {
    supported = false
    render(<Composer sessionId="s1" agent="claude" asking={false} onBack={vi.fn()} onFiles={vi.fn()} />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('dictation_status', {}))
    expect(screen.queryByTestId('desk-mic')).toBeNull()
    cleanup()
    resetDeskVoice()
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    render(<Composer sessionId="s1" agent="claude" asking={false} onBack={vi.fn()} onFiles={vi.fn()} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('desk-mic')).toBeNull()
  })
})

describe('voice input in the chat field', () => {
  it('shows the desktop mic and writes the field, not sending', async () => {
    const submitText = vi.fn(async () => true)
    render(<TerminalKeys send={vi.fn()} sessionId="s1" submitText={submitText} deskVoice placeholder="Message…" />)
    const mic = await screen.findByTestId('desk-mic')
    const field = screen.getByLabelText('Type to the session') as HTMLTextAreaElement
    fireEvent.click(mic, { detail: 0 })
    await waitFor(() => expect(mic).toHaveAttribute('data-phase', 'listening'))
    emit({ kind: 'partial', id: 1, text: 'run the tests' })
    expect(field.value).toBe('run the tests')
    fireEvent.click(mic, { detail: 0 })
    emit({ kind: 'end', id: 1 })
    expect(field.value).toBe('run the tests')
    expect(submitText).not.toHaveBeenCalled()
  })

  it('the phone keeps its own mic: no desktop mic beside it', async () => {
    render(<TerminalKeys send={vi.fn()} sessionId="s1" voice deskVoice={false} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('desk-mic')).toBeNull()
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeInTheDocument()
  })
})
