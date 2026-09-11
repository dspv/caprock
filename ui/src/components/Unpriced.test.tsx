import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { UnpricedNote, unpricedIssueURL } from './Unpriced'

describe('UnpricedNote', () => {
  it('presents known internal usage as quiet background information', () => {
    render(
      <UnpricedNote
        background={{ turns: 2, tokens: 41_000, models: ['codex-auto-review'] }}
      />,
    )

    expect(screen.getByText(/Background usage/)).toHaveTextContent(
      'Background usage · 41.0k tokens · Codex Auto Review · public price unavailable',
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

    expect(screen.getByText('Partial estimate')).toBeInTheDocument()
    expect(screen.getByText(/1,234 tokens not included/)).toBeInTheDocument()
    const report = screen.getByRole('link', { name: 'report model' })
    expect(report).toHaveAttribute('href', unpricedIssueURL(['future-model']))
    expect(report.getAttribute('href')).not.toContain('1234')
    expect(screen.queryByText(/not free/i)).not.toBeInTheDocument()
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
