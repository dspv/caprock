/**
 * The "Open in <terminal> ↗" button. What matters: it names the terminal it
 * will open; an ended session opens in one click; a session Caprock is
 * running is never stopped by a single click — moving it is chosen from the
 * menu; another terminal can be picked and is remembered; and with nothing
 * allowed, the reason is shown instead of a button that does nothing.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenInTerminal, resetTerminals } from './OpenInTerminal'

const h = vi.hoisted(() => ({
  open: vi.fn(async (_id: string, req: { terminal?: string; mode?: string }) => ({ terminal: { id: req.terminal ?? 'iterm2', name: 'iTerm2' }, mode: req.mode, command: 'claude --resume s1' })),
  save: vi.fn(async (s: unknown) => s),
  paired: false,
  terminals: [
    { id: 'iterm2', name: 'iTerm2' },
    { id: 'terminal', name: 'Terminal' },
  ],
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    isPairedDevice: () => h.paired,
    api: {
      ...actual.api,
      terminals: async () => ({ terminals: h.terminals, preferred: 'iterm2' }),
      openTerminal: h.open,
      saveSettings: h.save,
    },
  }
})

beforeEach(() => {
  resetTerminals()
  h.open.mockClear()
  h.save.mockClear()
  h.paired = false
})

describe('OpenInTerminal', () => {
  it('resumes an ended session in the preferred terminal with one click', async () => {
    render(<OpenInTerminal sessionID="s1" info={{ modes: ['resume'] }} />)
    fireEvent.click(await screen.findByText('Open in iTerm2 ↗'))
    await waitFor(() => expect(h.open).toHaveBeenCalledWith('s1', { terminal: 'iterm2', mode: 'resume' }))
    expect(await screen.findByText('opened in iTerm2')).toBeTruthy()
  })

  it('never moves a running session on a single click: the menu asks', async () => {
    render(<OpenInTerminal sessionID="s1" info={{ modes: ['move', 'fork'] }} />)
    fireEvent.click(await screen.findByText('Open in iTerm2 ↗'))
    expect(h.open).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(screen.getByText('Fork into iTerm2 ↗'))
    await waitFor(() => expect(h.open).toHaveBeenCalledWith('s1', { terminal: 'iterm2', mode: 'fork' }))
  })

  it('moves when moving is what was chosen', async () => {
    render(<OpenInTerminal sessionID="s1" info={{ modes: ['move', 'fork'] }} />)
    fireEvent.click(await screen.findByText('Open in iTerm2 ↗'))
    fireEvent.click(screen.getByText('Move to iTerm2 ↗'))
    await waitFor(() => expect(h.open).toHaveBeenCalledWith('s1', { terminal: 'iterm2', mode: 'move' }))
  })

  it('picks another terminal from the menu and remembers it', async () => {
    render(<OpenInTerminal sessionID="s1" info={{ modes: ['resume'] }} />)
    fireEvent.click(await screen.findByLabelText('Other terminals and ways to open'))
    fireEvent.click(screen.getByText('Terminal'))
    await waitFor(() => expect(h.save).toHaveBeenCalledWith({ terminal: 'terminal' }))
    fireEvent.click(screen.getAllByText('Open in Terminal ↗')[0]!)
    await waitFor(() => expect(h.open).toHaveBeenCalledWith('s1', { terminal: 'terminal', mode: 'resume' }))
  })

  it('says why when nothing is allowed', async () => {
    render(<OpenInTerminal sessionID="s1" info={{ modes: [], reason: 'It is still running in another terminal.' }} />)
    const btn = (await screen.findByText('Open in iTerm2 ↗')) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(screen.getByText('It is still running in another terminal.')).toBeTruthy()
  })

  it('is not offered to a paired device, or without an answer from the server', async () => {
    h.paired = true
    const { container } = render(<OpenInTerminal sessionID="s1" info={{ modes: ['resume'] }} />)
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe('')
    h.paired = false
    const r2 = render(<OpenInTerminal sessionID="s1" />)
    await new Promise((r) => setTimeout(r, 0))
    expect(r2.container.textContent).toBe('')
  })

  it('confirms a move in place on a compact row', async () => {
    render(<OpenInTerminal sessionID="s1" info={{ modes: ['move'] }} compact />)
    const btn = await screen.findByLabelText('Move to iTerm2')
    fireEvent.click(btn)
    expect(h.open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('move?'))
    await waitFor(() => expect(h.open).toHaveBeenCalledWith('s1', { terminal: 'iterm2', mode: 'move' }))
  })
})
