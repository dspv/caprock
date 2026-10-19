import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

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
import { resetSaved } from '@/lib/saved'
import { resetPickerCache } from './ChatPicker'
import { setComposerEnabled, composerEnabled } from '@/lib/composer'

// The placeholder's keys in their macOS spelling; lib/appkeys.test.ts covers the rest.
Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })

const view = (over: object = {}) => ({ session_id: 's1', messages: [], waiting: '', ...over })

function box(): HTMLTextAreaElement {
  return screen.getByLabelText('Message Claude') as HTMLTextAreaElement
}

describe('Composer', () => {
  beforeEach(() => {
    m.queue.mockResolvedValue(view())
    m.savedPrompts.mockResolvedValue({ items: [], max: 200 })
    m.queueSend.mockResolvedValue({ sent: true, queue: view({ waiting: 'turn' }) })
    m.sessionCommands.mockResolvedValue({ commands: [{ name: 'review', description: 'Review the diff', source: 'builtin' }] })
  })
  afterEach(() => {
    cleanup()
    resetSaved()
    resetPickerCache()
    localStorage.clear()
    vi.clearAllMocks()
  })

  const mount = (over: Partial<Parameters<typeof Composer>[0]> = {}) => {
    const onBack = vi.fn()
    const onFiles = vi.fn()
    render(<Composer sessionId="s1" agent="claude" asking={false} onBack={onBack} onFiles={onFiles} {...over} />)
    return { onBack, onFiles }
  }

  it('says how to send, newline and leave, in the placeholder', () => {
    mount()
    expect(box().placeholder).toBe('Message Claude…  ↩ send · ⇧↩ newline · Esc back to terminal')
  })

  it('sends a message of several lines as one, through the queue, on Enter', async () => {
    mount()
    fireEvent.change(box(), { target: { value: 'first line' } })
    // Shift+Enter is the textarea's own newline: nothing is sent.
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
    expect(m.queueSend).not.toHaveBeenCalled()
    fireEvent.change(box(), { target: { value: 'first line\nsecond line' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(m.queueSend).toHaveBeenCalledWith('s1', 'first line\nsecond line'))
    expect(m.queueSend).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(box().value).toBe(''))
  })

  it('sends nothing for an empty box', () => {
    mount()
    fireEvent.keyDown(box(), { key: 'Enter' })
    fireEvent.change(box(), { target: { value: '   ' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(m.queueSend).not.toHaveBeenCalled()
  })

  it('says a message is queued while the agent works', async () => {
    m.queueSend.mockResolvedValue({ sent: false, queue: view({ waiting: 'turn', messages: [{ id: 1, text: 'later', created_at: 0 }] }) })
    mount()
    fireEvent.change(box(), { target: { value: 'later' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByText('Message will send when the agent is free')).toBeInTheDocument()
  })

  it('keeps the text and says why when the send fails', async () => {
    m.queueSend.mockRejectedValue(new Error('daemon gone'))
    mount()
    fireEvent.change(box(), { target: { value: 'keep me' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByText(/Not sent: daemon gone/)).toBeInTheDocument()
    expect(box().value).toBe('keep me')
  })

  it('points at the terminal while a permission prompt is open', () => {
    mount({ asking: true })
    expect(screen.getByText('Claude is asking — answer in the terminal (1/2/3)')).toBeInTheDocument()
    expect(document.querySelector('[data-composer-box]')!.hasAttribute('data-asking')).toBe(true)
  })

  it('goes back to the terminal on Esc', () => {
    const { onBack } = mount()
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('walks the messages sent before with ↑ and ↓ from an empty box', async () => {
    mount()
    for (const t of ['one', 'two']) {
      fireEvent.change(box(), { target: { value: t } })
      fireEvent.keyDown(box(), { key: 'Enter' })
      await waitFor(() => expect(box().value).toBe(''))
    }
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(box().value).toBe('two')
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(box().value).toBe('one')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(box().value).toBe('two')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(box().value).toBe('')
    // A box with its own text keeps ↑ for the caret.
    fireEvent.change(box(), { target: { value: 'draft' } })
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(box().value).toBe('draft')
  })

  it('opens the / picker and puts the pick in the box', async () => {
    mount()
    fireEvent.change(box(), { target: { value: '/rev', selectionStart: 4, selectionEnd: 4 } })
    expect(await screen.findByRole('option', { name: /\/review/ })).toBeInTheDocument()
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(box().value).toBe('/review '))
    expect(m.queueSend).not.toHaveBeenCalled()
  })

  it('hands a pasted image to the terminal’s paste path', () => {
    const { onFiles } = mount()
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    fireEvent.paste(box(), { clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] } })
    expect(onFiles).toHaveBeenCalledWith([file])
  })

  it('puts a saved prompt in the box without sending it', async () => {
    m.savedPrompts.mockResolvedValue({ items: [{ id: 3, kind: 'prompt', name: 'Fix tests', text: 'Run the tests.', sort: 0, created_at: 0, updated_at: 0 }], max: 200 })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Saved' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Fix tests/ }))
    expect(box().value).toBe('Run the tests.')
    expect(m.queueSend).not.toHaveBeenCalled()
  })

  it('turns itself off from its own menu', () => {
    setComposerEnabled(true)
    const { onBack } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Composer options' }))
    act(() => { fireEvent.click(screen.getByRole('menuitem', { name: /Turn the composer off/ })) })
    expect(composerEnabled()).toBe(false)
    expect(onBack).toHaveBeenCalled()
  })
})
