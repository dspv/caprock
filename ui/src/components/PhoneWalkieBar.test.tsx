/**
 * The phone's one-row chat bar (TerminalKeys `walkie`, owner's variant D,
 * 2026-10-17): the read-aloud switch, the + sheet, the field and the round
 * hold-to-talk microphone; and the latest answer's card in ChatView.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '@/lib/api'
import { TerminalKeys } from './TerminalKeys'
import { ChatView } from './ChatView'
import { resetAutoRead, READ_ALOUD_KEY } from '@/lib/readAloud'
import { resetTldr } from '@/lib/tldr'
import { resetQuickReplies } from '@/lib/quickReplies'

const store = vi.hoisted(() => ({ events: [] as Event[], inputs: [] as string[], sent: [] as string[] }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      recentEvents: async () => store.events,
      eventsBefore: async () => [],
      agentInput: async (_id: string, data: string) => { store.inputs.push(data) },
      permission: async () => ({ permission: null }),
      queue: async (id: string) => ({ session_id: id, waiting: '', messages: [] }),
      queueSend: async (id: string, text: string) => {
        store.sent.push(text)
        return { sent: true, queue: { session_id: id, waiting: '', messages: [] } }
      },
      settings: async () => ({ quick_replies: [{ label: 'Continue', text: 'Continue.' }] }),
      sessionCommands: async () => ({ agent: 'claude', commands: [] }),
      sessionFiles: async () => ({ files: [] }),
      savedPrompts: async () => [],
      savedFor: async () => [],
    },
  }
})

/** A SpeechRecognition stand-in: what the test says it heard, ended on stop. */
let rec: { onresult?: (e: unknown) => void; onend?: () => void; stopped?: boolean } = {}
function fakeRecognition() {
  ;(window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = class {
    onresult?: (e: unknown) => void
    onend?: () => void
    stopped = false
    constructor() { rec = this }
    start() {}
    stop() { this.stopped = true; this.onend?.() }
  }
  vi.stubGlobal('isSecureContext', true)
}
const hear = (text: string) => act(() => rec.onresult?.({ results: [{ isFinal: true, 0: { transcript: text } }] }))

beforeEach(() => {
  localStorage.clear()
  resetAutoRead()
  resetTldr()
  resetQuickReplies([{ label: 'Continue', text: 'Continue.' }])
  store.events = []
  store.inputs = []
  store.sent = []
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
})

describe('the phone bar', () => {
  it('is one row: speaker, +, field and microphone, with no Send, Keys or language chip', () => {
    render(<TerminalKeys send={vi.fn()} walkie voice />)
    expect(screen.getByRole('switch', { name: 'Read answers aloud' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^More: photo, new chat, report a bug/ })).toBeTruthy()
    expect(screen.getByLabelText('Type to the session')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hold to talk' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Keys' })).toBeNull()
    expect(screen.queryByTestId('speech-lang')).toBeNull()
  })

  it('remembers the read-aloud switch per device, on by default', () => {
    render(<TerminalKeys send={vi.fn()} walkie />)
    const sw = screen.getByRole('switch', { name: 'Read answers aloud' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(localStorage.getItem(READ_ALOUD_KEY)).toBe('off')
    cleanup()
    resetAutoRead()
    render(<TerminalKeys send={vi.fn()} walkie />)
    expect(screen.getByRole('switch', { name: 'Read answers aloud' }).getAttribute('aria-checked')).toBe('false')
  })

  it('sends on Enter', async () => {
    const submitText = vi.fn(async () => true)
    render(<TerminalKeys send={vi.fn()} submitText={submitText} walkie />)
    const field = screen.getByLabelText('Type to the session')
    fireEvent.change(field, { target: { value: 'push it' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(submitText).toHaveBeenCalledWith('push it'))
  })

  it('holds to record, shows what is heard, and sends on release', async () => {
    fakeRecognition()
    const submitText = vi.fn(async () => true)
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    render(<TerminalKeys send={vi.fn()} submitText={submitText} walkie voice />)
    const mic = screen.getByRole('button', { name: 'Hold to talk' })
    fireEvent.pointerDown(mic, { pointerId: 1 })
    expect(screen.getByRole('status').textContent).toMatch(/release to send/)
    hear('push it and re-run CI')
    expect((screen.getByLabelText('Type to the session') as HTMLTextAreaElement).value).toBe('push it and re-run CI')
    now += 1200
    fireEvent.pointerUp(screen.getByRole('button', { name: /Recording/ }), { pointerId: 1 })
    await waitFor(() => expect(submitText).toHaveBeenCalledWith('push it and re-run CI'))
    vi.restoreAllMocks()
  })

  it('latches on a short tap and sends on the next tap', async () => {
    fakeRecognition()
    const submitText = vi.fn(async () => true)
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    render(<TerminalKeys send={vi.fn()} submitText={submitText} walkie voice />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to talk' }), { pointerId: 1 })
    now += 100
    fireEvent.pointerUp(screen.getByRole('button', { name: /Recording/ }), { pointerId: 1 })
    expect(rec.stopped).toBe(false)
    expect(screen.getByRole('button', { name: 'Recording — tap to send' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/tap the mic again to send/)
    hear('merge it when green')
    now += 3000
    const mic = screen.getByRole('button', { name: 'Recording — tap to send' })
    fireEvent.pointerDown(mic, { pointerId: 2 })
    fireEvent.pointerUp(mic, { pointerId: 2 })
    await waitFor(() => expect(submitText).toHaveBeenCalledWith('merge it when green'))
    vi.restoreAllMocks()
  })

  it('cancels when the finger slides off, putting back what was typed', () => {
    fakeRecognition()
    const submitText = vi.fn(async () => true)
    render(<TerminalKeys send={vi.fn()} submitText={submitText} walkie voice />)
    const field = screen.getByLabelText('Type to the session') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'Also:' } })
    const mic = screen.getByRole('button', { name: 'Hold to talk' })
    mic.getBoundingClientRect = () => ({ left: 300, right: 348, top: 700, bottom: 748, width: 48, height: 48, x: 300, y: 700, toJSON: () => ({}) })
    fireEvent.pointerDown(mic, { pointerId: 1 })
    hear('never mind')
    expect(field.value).toBe('Also: never mind')
    fireEvent.pointerMove(mic, { pointerId: 1, clientX: 320, clientY: 560 })
    expect(field.value).toBe('Also:')
    expect(screen.getByRole('status').textContent).toMatch(/Cancelled — nothing sent/)
    expect(submitText).not.toHaveBeenCalled()
  })

  it('says how to dictate on an http page instead of recording', () => {
    ;(window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = class {}
    vi.stubGlobal('isSecureContext', false)
    render(<TerminalKeys send={vi.fn()} walkie voice />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to talk' }), { pointerId: 1 })
    expect(screen.getByRole('status').textContent).toMatch(/https.*keyboard/)
    expect(screen.getByRole('button', { name: 'Hold to talk' })).toBeTruthy()
  })

  it('opens Photo, New chat and Report a bug from +', () => {
    render(<TerminalKeys send={vi.fn()} attach={async () => []} walkie />)
    fireEvent.click(screen.getByRole('button', { name: /^More: photo/ }))
    expect(screen.getByRole('menuitem', { name: 'Photo' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Report a bug' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'New chat' }))
    expect(window.location.hash).toBe('#/?open=chat')
    window.location.hash = ''
  })
})

function ev(id: number, kind: string, payload: unknown, s = 0): Event {
  return { id, ts: new Date(Date.UTC(2026, 9, 17, 9, 0, s)).toISOString(), session_id: 's', source: 'hook', kind, payload }
}

describe('the latest answer on a phone', () => {
  it('carries AI;DR, Read aloud, Continue and Stop, and swaps in the summary', async () => {
    store.events = [
      ev(1, 'turn.user', { prompt: 'Why did Windows fail?' }, 1),
      ev(2, 'turn.assistant', { text: 'A long answer about a path separator.' }, 2),
      ev(3, 'agent.stop', {}, 3),
    ]
    const fetch = vi.fn(async () => new Response(JSON.stringify({ tldr: 'Path separator; fixed.', cached: false }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    render(<ChatView sessionId="s" canType phone />)
    await screen.findByText('A long answer about a path separator.')
    fireEvent.click(screen.getByRole('button', { name: /AI;DR/ }))
    expect(await screen.findByText('Path separator; fixed.')).toBeTruthy()
    expect(screen.queryByText('A long answer about a path separator.')).toBeNull()
    expect(screen.getByRole('button', { name: /Full answer/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Full answer/ }))
    expect(screen.getByText('A long answer about a path separator.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /AI;DR/ }))
    expect(await screen.findByText('Path separator; fixed.')).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    await waitFor(() => expect(store.sent).toEqual(['Continue.']))
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }))
    await waitFor(() => expect(store.inputs).toContain('\x1b'))
    // No quick-replies row on the phone: the card carries them.
    expect(document.querySelector('[data-quick-replies]')).toBeNull()
  })

  it('shows the error in a toast when no summary can be made', async () => {
    store.events = [ev(2, 'turn.assistant', { text: 'An answer.' }, 2)]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no agent CLI can summarise' }), { status: 503 })))
    render(<ChatView sessionId="s" canType phone />)
    await screen.findByText('An answer.')
    fireEvent.click(screen.getByRole('button', { name: /AI;DR/ }))
    await waitFor(() => expect(document.querySelector('[data-chat-toast]')?.textContent).toBe('no agent CLI can summarise'))
    expect(screen.getByText('An answer.')).toBeTruthy()
  })

  it('reads a new answer aloud once its turn ends, and not the one already there', async () => {
    const spoken: string[] = []
    vi.stubGlobal('SpeechSynthesisUtterance', class { lang = ''; volume = 1; onend = null; onerror = null; constructor(public text: string) {} })
    vi.stubGlobal('speechSynthesis', { cancel: () => {}, speak: (u: { text: string }) => { if (u.text) spoken.push(u.text) } })
    store.events = [ev(2, 'turn.assistant', { text: 'Old answer.' }, 2), ev(3, 'agent.stop', {}, 3)]
    const { live } = await import('@/lib/live')
    render(<ChatView sessionId="s" canType phone />)
    await screen.findByText('Old answer.')
    expect(spoken).toEqual([])
    act(() => {
      live.handle({ type: 'event', data: ev(4, 'turn.assistant', { text: 'New answer.' }, 4) })
    })
    await screen.findByText('New answer.')
    expect(spoken).toEqual([])
    act(() => {
      live.handle({ type: 'event', data: ev(5, 'agent.stop', {}, 5) })
    })
    await waitFor(() => expect(spoken).toEqual(['New answer.']))
  })

  it('leaves the desktop chat as it was', async () => {
    store.events = [ev(2, 'turn.assistant', { text: 'An answer.' }, 2)]
    render(<ChatView sessionId="s" canType />)
    await screen.findByText('An answer.')
    expect(screen.queryByRole('button', { name: /AI;DR/ })).toBeNull()
    expect(document.querySelector('[data-walkie-bar]')).toBeNull()
  })
})
