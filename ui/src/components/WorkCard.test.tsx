import { render, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildWork } from '@/lib/work'
import { NOW, statsFixture, workFixture } from '@/lib/work.fixture'
import { WorkCard } from './WorkCard'

describe('a Kanban card', () => {
  it('carries what the row does: title, bar and word, who, estimates, elapsed and cost', () => {
    const it631 = buildWork(workFixture(), new Map([['/w/caprock', statsFixture()]]), NOW).items.find((it) => it.pr?.number === 631)!
    render(<ul><WorkCard it={it631} now={NOW} passed={0} flow={statsFixture().board!.flow} /></ul>)
    const card = document.querySelector('[data-work-card]') as HTMLElement
    expect(within(card).getByText('folder search').closest('a')).toHaveAttribute('href', expect.stringContaining('pr=631'))
    expect(card.querySelector('[data-work-bar]')).toHaveAttribute('data-work-bar', '3')
    expect(card).toHaveTextContent('CI running')
    expect(card).toHaveTextContent('Claude Code Opus 4.1')
    expect(card).toHaveTextContent('turn 1–4 min left (rough)')
    expect(card).toHaveTextContent('$5.10')
  })

  it('marks one that needs you', () => {
    const s2 = buildWork(workFixture(), new Map(), NOW).items.find((it) => it.key === 's:s2')!
    render(<ul><WorkCard it={s2} now={NOW} passed={0} /></ul>)
    expect(document.querySelector('[data-work-card]')).toHaveAttribute('data-needs-you', 'true')
  })
})
