/**
 * The donuts on a 14-inch screen: the bill-by-token-type legend read
 * "cach…", "uncached…" and the centre "re-reading cont…" (owner, 2026-10-12).
 * Labels are short and never clipped, and hovering or focusing a slice shows
 * its full reading in the centre, in place, never in a floating popup.
 */
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Donut, type Segment } from './Donut'
import { glanceCharts } from './AtAGlance'
import type { Glance } from '@/lib/api'

const segs: Segment[] = [
  { key: 'cache_read', label: 'cache read', detail: 're-reading context', value: 60, display: '$60.00' },
  { key: 'output', label: 'output', value: 30, display: '$30.00' },
  { key: 'input', label: 'input', detail: 'uncached', value: 10, display: '$10.00' },
]

const donut = () => render(<Donut title="The bill by token type" segments={segs} center="60%" centerLabel="re-reading context" ariaLabel="bill" />)
const centre = (c: HTMLElement) => c.querySelector('[data-donut-center]')!.textContent

describe('Donut', () => {
  it('prints the centre caption whole, wrapping instead of clipping', () => {
    const { container } = donut()
    expect(centre(container)).toBe('60%re-reading context')
    expect(container.textContent).not.toContain('…')
    expect(container.querySelector('.truncate')).toBeNull()
  })

  it('shows a legend detail under its label', () => {
    const { getByText } = donut()
    expect(getByText('re-reading context', { selector: 'li span span' })).toBeTruthy()
    expect(getByText('uncached')).toBeTruthy()
  })

  it('hovering a legend row puts that slice in the centre and lights it', () => {
    const { container } = donut()
    const row = container.querySelectorAll('li')[1]!
    fireEvent.mouseEnter(row)
    expect(centre(container)).toBe('30%output$30.00')
    expect(row.getAttribute('data-active')).toBe('true')
    const paths = container.querySelectorAll('svg path, svg circle + path')
    expect([...paths].some((p) => (p as SVGElement).style.opacity === '0.28')).toBe(true)
    fireEvent.mouseLeave(row)
    expect(centre(container)).toBe('60%re-reading context')
  })

  it('keyboard focus on a row does the same as hover', () => {
    const { container } = donut()
    const row = container.querySelectorAll('li')[2]!
    expect(row.tabIndex).toBe(0)
    fireEvent.focus(row)
    expect(centre(container)).toBe('10%input$10.00')
    fireEvent.blur(row)
    expect(centre(container)).toBe('60%re-reading context')
  })

  it('hovering a slice shows it too, with no tooltip element', () => {
    const { container } = donut()
    fireEvent.mouseEnter(container.querySelectorAll('svg path')[0]!)
    expect(centre(container)).toBe('60%cache read$60.00')
    expect(container.querySelector('[role="tooltip"]')).toBeNull()
  })
})

describe('glanceCharts bill labels', () => {
  it('uses the short names the rest of the app uses', () => {
    const g = { agents: [], display: {}, bill: { input_usd: 1, output_usd: 2, cache_write_usd: 3, cache_read_usd: 4 } } as unknown as Glance
    const { bill } = glanceCharts(undefined, g)
    expect(bill.map((s) => s.label)).toEqual(['cache read', 'cache write', 'output', 'input'])
    expect(bill.find((s) => s.key === 'cache_read')!.detail).toBe('re-reading context')
  })
})
