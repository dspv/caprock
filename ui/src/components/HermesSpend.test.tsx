import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HermesSpendPanel, hermesSourceLabel } from './HermesSpend'

describe('Hermes on the Cost screen', () => {
  it('shows nothing on a machine without Hermes turns', () => {
    const { container } = render(<HermesSpendPanel range="30d" />)
    expect(container.textContent).toBe('')
  })

  it('labels which figure is the provider’s and which is Hermes’s estimate, and splits off background runs', () => {
    render(
      <HermesSpendPanel
        range="7d"
        h={{ total_usd: 3.5, actual_usd: 1.25, estimated_usd: 2.25, background_usd: 0.75, sources: [{ source: 'cron', cost_usd: 0.5 }, { source: 'telegram', cost_usd: 0.25 }], unpriced_turns: 2, included_turns: 1 }}
      />,
    )
    expect(screen.getByText('Provider-reported')).toBeInTheDocument()
    expect(screen.getByText('$1.25')).toBeInTheDocument()
    expect(screen.getByText('Hermes estimate')).toBeInTheDocument()
    expect(screen.getByText('$2.25')).toBeInTheDocument()
    expect(screen.getByText('Background')).toBeInTheDocument()
    expect(screen.getByText(/cron jobs \$0\.50 · telegram \$0\.25/)).toBeInTheDocument()
    expect(screen.getByText(/2 turns Hermes could not price are not in these figures/)).toBeInTheDocument()
    expect(screen.getByText(/1 on a subscription route/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Hermes' })).toBeInTheDocument()
  })

  it('names sources in words', () => {
    expect(hermesSourceLabel('cron')).toBe('cron jobs')
    expect(hermesSourceLabel('oneshot')).toBe('one-shot runs')
    expect(hermesSourceLabel('slack')).toBe('slack')
  })
})
