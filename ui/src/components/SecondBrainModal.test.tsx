import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, glance: vi.fn(() => Promise.resolve({ agents: [], display: {} })) } }
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
      'The next agent starts smarter',
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
    expect(details.textContent).toMatch(/up to five/)
    expect(details.textContent).toMatch(/handoff/)
    expect(details.textContent).toMatch(/Nothing leaves your computer except the call your own claude makes/)
    expect(details.textContent).toMatch(/Settings → Second Brain/)
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
