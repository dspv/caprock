import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildWork } from '@/lib/work'
import { NOW, statsFixture, workFixture } from '@/lib/work.fixture'
import { WorkColumn, WorkLane } from './WorkLane'

const items = buildWork(workFixture(), new Map([['/w/caprock', statsFixture()]]), NOW).items
const base = { id: 'x', label: 'Next release', note: 'n', now: NOW, passed: 0, flowOf: () => undefined, showRepo: true }

describe('a Work group', () => {
  it('lists its rows under its name and count, and shows the rest on asking', () => {
    render(<WorkLane {...base} items={items} limit={3} />)
    expect(screen.getByRole('button', { name: /Next release/ })).toHaveTextContent(String(items.length))
    expect(document.querySelectorAll('[data-work-row]')).toHaveLength(3)
    fireEvent.click(screen.getByText(`Show ${items.length - 3} more`))
    expect(document.querySelectorAll('[data-work-row]')).toHaveLength(items.length)
  })

  it('is not drawn empty unless it has something to say', () => {
    const { container, rerender } = render(<WorkLane {...base} items={[]} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<WorkLane {...base} items={[]} empty="Nothing here yet." />)
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument()
  })

  it('folds and unfolds', () => {
    render(<WorkLane {...base} items={items} folded />)
    expect(document.querySelector('[data-work-row]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Next release/ }))
    expect(document.querySelector('[data-work-row]')).not.toBeNull()
  })
})

describe('a Kanban column', () => {
  it('draws its cards, and says when it has none', () => {
    const { rerender } = render(<WorkColumn {...base} label="In review" items={items.slice(0, 2)} />)
    expect(document.querySelectorAll('[data-work-card]')).toHaveLength(2)
    rerender(<WorkColumn {...base} label="In review" items={[]} />)
    expect(screen.getByText('Nothing here.')).toBeInTheDocument()
  })
})
