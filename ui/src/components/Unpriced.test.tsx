import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UnpricedNote, cursorUnpricedReason, unpricedIssueURL } from './Unpriced'

describe('UnpricedNote', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('presents known internal usage as quiet background information', () => {
    render(
      <UnpricedNote
        background={{ turns: 2, tokens: 41_000, models: ['codex-auto-review'] }}
      />,
    )

    expect(screen.getByText(/Background usage/)).toHaveTextContent(
      'Background usage · 41.0k tokens · Codex Auto Review',
    )
    expect(screen.queryByText('Partial estimate')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('keeps a compact actionable warning for a genuinely unknown model', () => {
    render(
      <UnpricedNote
        u={{ turns: 1, tokens: 1_234, models: ['future-model'] }}
      />,
    )

    expect(screen.getByText('Partial cost')).toBeInTheDocument()
    expect(screen.getByText(/1,234 tokens not priced/)).toBeInTheDocument()
    const report = screen.getByRole('link', { name: 'report' })
    expect(report).toHaveAttribute('href', unpricedIssueURL(['future-model']))
    expect(report.getAttribute('href')).not.toContain('1234')
    expect(screen.queryByText(/not free/i)).not.toBeInTheDocument()
  })

  it('explains the lower-bound total only when asked', () => {
    render(<UnpricedNote u={{ turns: 1, tokens: 1_234, models: ['future-model'] }} />)

    expect(screen.queryByText(/lower bound/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'why?' }))
    expect(screen.getByText(/lower bound/)).toBeInTheDocument()
    expect(screen.getByText(/no manual price to enter/)).toBeInTheDocument()
  })

  it('copies only the model id, never usage or project data', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<UnpricedNote u={{ turns: 1, tokens: 1_234, models: ['future-model'] }} />)

    fireEvent.click(screen.getByRole('button', { name: 'copy model' }))
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('future-model'))
  })

  // The owner's screen read "137.96M tokens not priced · claude-4-sonnet,
  // default, composer-1, …" — Cursor chats Cursor recorded no cost for, which
  // looked like a Caprock bug. They are said apart, with why (ADR-095).
  it('says why Cursor names are unpriced instead of listing them as unknown', () => {
    render(
      <UnpricedNote
        u={{
          turns: 41,
          tokens: 137_960_077,
          models: ['claude-4-sonnet', 'default', '', 'composer-1', 'future-model'],
          cursor: ['claude-4-sonnet', 'default', '', 'composer-1'],
        }}
      />,
    )

    expect(screen.getByText(/Cursor recorded no cost:/)).toBeInTheDocument()
    expect(screen.getByText('Cursor’s Auto')).toHaveAttribute('title', expect.stringContaining('Cursor does not say which model ran'))
    expect(screen.getByText('composer-1')).toHaveAttribute('title', expect.stringContaining('no per-token price Cursor publishes'))
    expect(screen.getByText('claude-4-sonnet')).toHaveAttribute('title', expect.stringContaining('Cursor recorded no cost'))
    expect(screen.getByText('no model named')).toBeInTheDocument()
    // Only the genuinely unknown id is offered for a report.
    expect(screen.getByRole('link', { name: 'report' })).toHaveAttribute('href', unpricedIssueURL(['future-model']))
    expect(screen.getByTitle('future-model')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'why?' }))
    expect(screen.getByText(/not a missing price in Caprock/)).toBeInTheDocument()
  })

  it('offers no report when every unpriced name is Cursor’s', () => {
    render(<UnpricedNote u={{ turns: 3, tokens: 9_000, models: ['default'], cursor: ['default'] }} />)

    expect(screen.queryByRole('link', { name: 'report' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'copy model' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'why?' }))
    expect(screen.queryByText(/no manual price to enter/)).not.toBeInTheDocument()
  })

  it('names each kind of Cursor reason in plain words', () => {
    expect(cursorUnpricedReason('default').label).toBe('Cursor’s Auto')
    expect(cursorUnpricedReason('auto').title).toMatch(/does not say which model ran/)
    expect(cursorUnpricedReason('code-supernova-1-million').title).toMatch(/Cursor’s own model/)
    expect(cursorUnpricedReason('').label).toBe('no model named')
    expect(cursorUnpricedReason('gpt-5').title).toBe('gpt-5: Cursor recorded no cost for these chats, and Caprock does not estimate Cursor’s bill from list prices.')
  })

  it('renders nothing when neither category contains turns', () => {
    const { container } = render(
      <UnpricedNote
        u={{ turns: 0, tokens: 0, models: [] }}
        background={{ turns: 0, tokens: 0, models: [] }}
      />,
    )

    expect(container).toBeEmptyDOMElement()
  })
})
