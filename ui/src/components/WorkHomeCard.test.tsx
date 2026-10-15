import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NOW, workFixture } from '@/lib/work.fixture'
import { WorkHomeCardView } from './WorkHomeCard'

describe('Work on Home', () => {
  it('says the headline and the rows that need you or are working first, with the way to the page', () => {
    render(<WorkHomeCardView work={workFixture()} now={NOW} openHref="#/work" />)
    const card = document.querySelector('[data-work-home]') as HTMLElement
    expect(card).toHaveTextContent('4 agents live · 1 building · 2 on open PRs · 1 needs you')
    const rows = [...card.querySelectorAll('[data-work-home-row]')]
    expect(rows[0]).toHaveTextContent('needs you')
    expect(rows[0]).toHaveTextContent('Pipeline in Dashboard')
    expect(card.querySelector('[data-work-open-page]')).toHaveAttribute('href', '#/work')
  })

  it('draws nothing with no agent live', () => {
    const w = workFixture()
    w.totals.live = 0
    const { container } = render(<WorkHomeCardView work={w} now={NOW} />)
    expect(container).toBeEmptyDOMElement()
  })
})
