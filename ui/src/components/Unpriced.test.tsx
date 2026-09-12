import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UnpricedNote, unpricedIssueURL } from './Unpriced'

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
