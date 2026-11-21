import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelCost, UnpricedNote, cursorUnpricedReason, modelCostState, modelCostText, unpricedIssueURL } from './Unpriced'

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

    expect(screen.getByText(/In your Cursor plan, no cost recorded:/)).toBeInTheDocument()
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
    expect(cursorUnpricedReason('gpt-5').title).toBe('gpt-5: Cursor recorded no cost for these chats, most often because your Cursor plan covers them, and Caprock does not estimate Cursor’s bill from list prices.')
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

describe('ModelCost', () => {
  const u = { turns: 3, tokens: 12_000_000, models: ['claude-4-sonnet', 'composer-1', 'future-model'], cursor: ['claude-4-sonnet', 'composer-1'] }
  const row = (model: string, cost_usd: number, unpriced_tokens?: number) =>
    ({ model, tokens: 20_000_000, cost_usd, turns: 4, output: 0, cache_read: 0, ...(unpriced_tokens ? { unpriced_tokens } : {}) })

  it('shows the priced part of a partly priced Cursor model, then a quiet in-plan mark', () => {
    // The owner's claude-4-sonnet: $153.13 recorded by Cursor in some chats,
    // none in others. "unpriced" alone hid the $153.13.
    const m = row('claude-4-sonnet', 153.13, 11_500_000)
    const { container } = render(<ModelCost m={m} u={u} />)
    expect(container).toHaveTextContent('$153.13+ in Cursor plan')
    const cell = screen.getByLabelText('$153.13 plus a part in the Cursor plan')
    expect(cell.title).toMatch(/^\$153\.13 is the priced part\. 11\.50M more tokens have no cost\. claude-4-sonnet: Cursor recorded no cost/)
    expect(cell.title).toMatch(/share, the order and the total count the priced part alone\.$/)
    expect(modelCostState(m, u)).toBe('partly')
    expect(modelCostText(m, u)).toBe('$153.13 + in Cursor plan')
  })

  it('calls a fully unpriced Cursor model "in Cursor plan", any other "unpriced", with its reason', () => {
    const m = row('composer-1', 0, 770)
    render(<ModelCost m={m} u={u} />)
    expect(screen.getByText('in Cursor plan').title).toMatch(/Cursor’s own model/)
    expect(modelCostText(m, u)).toBe('in Cursor plan')
    expect(modelCostText(row('future-model', 0), u)).toBe('unpriced')
    // An older daemon sends no unpriced_tokens: named in unpriced, the row
    // reads unpriced throughout, as it did.
    expect(modelCostState(row('future-model', 0), u)).toBe('unpriced')
  })

  it('leaves a priced model as its figure alone', () => {
    const m = row('claude-sonnet-5', 2.5)
    const { container } = render(<ModelCost m={m} u={u} />)
    expect(container).toHaveTextContent(/^\$2\.50$/)
    expect(modelCostState(m, u)).toBe('priced')
    expect(modelCostText(m, undefined)).toBe('$2.50')
  })
})
