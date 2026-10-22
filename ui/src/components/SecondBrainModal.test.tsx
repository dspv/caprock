import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, glance: vi.fn(() => Promise.resolve({ agents: [], display: {} })),
    brainStatus: vi.fn(() => Promise.resolve({ memories: 0, manual: 0, projects: [], db_path: '/Users/me/Library/Application Support/caprock/caprock.db' })) } }
})

import { SecondBrainModal } from './SecondBrainModal'

describe('SecondBrainModal', () => {
  it('is short: the agents and the brain, Free, a headline, the agents line, three one-line steps, Jarvis and Free-and-local in a line each', () => {
    render(<SecondBrainModal onClose={() => {}} onOpen={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Second Brain' })
    expect(dialog.querySelector('[data-brain-hero] [data-brain-mark]')).not.toBeNull()
    expect(dialog.querySelector('[data-brain-free]')!.textContent).toBe('Free')
    expect(screen.getByRole('heading', { name: 'One memory for all your agents' })).toBeTruthy()
    // No usage known yet: Claude Code alone.
    expect(dialog.querySelector('[data-brain-agents-line]')!.textContent).toBe('Claude Code remembers across sessions.')
    const steps = screen.getByRole('list', { name: 'How it works' })
    expect([...steps.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Sessions end',
      'Your Claude reads them, on this computer',
      'Your next Claude Code session starts with the memories',
    ])
    expect(dialog.querySelector('[data-brain-jarvis]')!.textContent).toBe('Over time: your personal Jarvis.')
    expect(dialog.querySelector('[data-brain-privacy]')!.textContent).toBe('Free — runs on your own Claude, on this computer.')
    expect(dialog.textContent).not.toMatch(/Premium|\$/)
    // No second Close: the × (and Escape) close it.
    expect(screen.getAllByRole('button', { name: /^Close/ })).toHaveLength(1)
  })

  it('keeps the daemon’s defaults in Details, folded, not in the main read', () => {
    render(<SecondBrainModal onClose={() => {}} onOpen={() => {}} />)
    const details = document.querySelector<HTMLDetailsElement>('[data-brain-details]')!
    expect(details.open).toBe(false)
    expect(screen.getByRole('list', { name: 'How it works' }).textContent).not.toMatch(/Haiku|300k/)
    // The defaults are the daemon's (internal/brain/engine.go), not invented.
    expect(details.textContent).toMatch(/Haiku/)
    expect(details.textContent).toMatch(/300k tokens a day/)
    expect(details.textContent).toMatch(/Up to 5 memories/)
    expect(details.textContent).toMatch(/change in Settings/)
    // Readable: at most three lines of about ten words, in the text colour.
    const items = [...details.querySelectorAll('li')].map((li) => li.textContent ?? '')
    expect(items.length).toBeLessThanOrEqual(3)
    for (const t of items) expect(t.split(/\s+/).length).toBeLessThanOrEqual(11)
    expect(details.className).toMatch(/\btext-fg\b/)
  })

  // Owner, 2026-10-15: show where the data lives — the daemon's real path.
  it('says under Details where it is kept: the daemon’s path, the tables, and what leaves the machine', async () => {
    render(<SecondBrainModal onClose={() => {}} onOpen={() => {}} />)
    const where = document.querySelector('[data-brain-details] [data-brain-where]')!
    expect(where.textContent).toMatch(/Where it’s kept/)
    await screen.findByText('/Users/me/Library/Application Support/caprock/caprock.db')
    expect(where.textContent).toMatch(/brain_nodes · brain_edges · brain_runs/)
    expect(where.querySelector('[data-brain-leaves]')!.textContent).toBe('The session text goes to Anthropic through your own Claude to be read; nothing goes to Caprock.')
    expect(where.querySelector('[data-brain-db-copy]')!.textContent).toBe('Copy path')
    // No reveal in Finder or Explorer exists, so none is offered.
    expect(where.textContent).not.toMatch(/Show in/)
  })

  it('opens the Second Brain screen and closes', () => {
    const onOpen = vi.fn()
    const onClose = vi.fn()
    render(<SecondBrainModal onClose={onClose} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Second Brain' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on the × and on Escape', () => {
    const onClose = vi.fn()
    render(<SecondBrainModal onClose={onClose} onOpen={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('has no open button without somewhere to go, only Got it', () => {
    const onClose = vi.fn()
    render(<SecondBrainModal onClose={onClose} />)
    expect(screen.queryByRole('button', { name: 'Open Second Brain' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
