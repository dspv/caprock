/**
 * A row's summary shortens rather than being cut at the inspector's edge
 * (owner, 2026-10-22: "511 files +35244 −7781 Review and co" at the edge).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { FitSummary } from './FitSummary'

// jsdom lays nothing out: each wording's width is its text length × 6px,
// the room is what a test sets.
let room = 0
const desc = {
  offset: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
  client: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth'),
}
function layout(px: number) {
  room = px
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return (this as HTMLElement).textContent!.length * 6 } })
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get() { return (this as Element).hasAttribute('data-fit-summary') ? room : 0 } })
}
afterEach(() => {
  if (desc.offset) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', desc.offset)
  if (desc.client) Object.defineProperty(Element.prototype, 'clientWidth', desc.client)
})

const variants = ['511 files +35244 −7781 Review and commit', '511 files +35.2k −7.8k Review', '511 files']

function shown(c: HTMLElement) {
  const box = c.querySelector('[data-fit-summary]')!
  const pick = Number(box.getAttribute('data-fit-pick'))
  return box.querySelector(`[data-fit-variant="${pick}"]`)?.textContent ?? ''
}

describe('FitSummary', () => {
  it('shows the widest wording that fits', () => {
    layout(1000)
    const { container } = render(<FitSummary variants={variants} />)
    expect(shown(container)).toBe(variants[0])
  })
  it('steps down to a shorter wording when the room is tight', () => {
    layout(200)
    const { container } = render(<FitSummary variants={variants} />)
    expect(shown(container)).toBe(variants[1])
  })
  it('shows nothing rather than cutting the last wording', () => {
    layout(20)
    const { container } = render(<FitSummary variants={variants} />)
    expect(shown(container)).toBe('')
  })
  it('hides the wordings not picked from the accessibility tree', () => {
    layout(200)
    const { container } = render(<FitSummary variants={variants} />)
    const hidden = container.querySelectorAll('[data-fit-variant][aria-hidden="true"]')
    expect(hidden).toHaveLength(2)
  })
})
