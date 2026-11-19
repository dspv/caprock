/**
 * The folded CI line's bar (owner, 2026-11-19): a segment per check,
 * coloured by its state and failed at the left edge, decorative to a screen
 * reader, which hears the summary in words.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CheckSummary } from './CheckSummary'
import { prChecks } from '@/lib/ci'

const t0 = 1_000_000
const ok = (name: string) => ({ name, state: 'pass', status: 'completed', started_at: t0, completed_at: t0 + 60_000 })
const sum = (items: object[]) => prChecks({ live: { checks: { items } } } as never, t0 + 5 * 60_000)!

afterEach(cleanup)

describe('the folded CI line’s bar', () => {
  it('draws a segment per check, coloured by its state, failed first, and keeps the words as its name', () => {
    const s = sum([ok('a'), { name: 'b', state: 'pending', status: 'in_progress', started_at: t0 }, { name: 'c', state: 'fail', status: 'completed' }, { name: 'd', state: 'skipped' }])
    render(<CheckSummary s={s} bar={96} label="#949: its checks" focusable={false} beside />)
    const bar = document.querySelector('[data-check-bar]')!
    expect(bar).toHaveAttribute('data-check-bar', 'segments')
    expect(bar).toHaveAttribute('aria-hidden')
    expect((bar as HTMLElement).style.width).toBe('96px')
    expect([...bar.querySelectorAll('i')].map((i) => i.getAttribute('data-tone'))).toEqual(['fail', 'pass', 'running'])
    const summary = document.querySelector('[data-check-summary]')!
    expect(summary).toHaveAttribute('aria-label', '#949: its checks: 4 checks: 1 failed, 1 running, 1 passed, 1 skipped or cancelled')
    expect(summary.textContent).toBe('1 failed · 1/3 · 1 running · 5m · 1 skipped')
    expect(document.querySelector('[data-check-part="fail"]')).toHaveClass('text-danger')
    expect(document.querySelector('[data-check-part="running"]')).toHaveClass('text-warn')
  })

  it('all passed reads "1/1 passed" in green', () => {
    render(<CheckSummary s={sum([ok('a')])} bar={96} label="#1: its checks" />)
    expect(document.querySelector('[data-check-part="pass"]')).toHaveTextContent(/^1\/1 passed$/)
    expect(document.querySelector('[data-check-part="pass"]')).toHaveClass('text-ok')
    expect(document.querySelectorAll('[data-check-bar] i')).toHaveLength(1)
  })

  it('fills in proportion when the checks are too many for a segment each', () => {
    const s = sum(Array.from({ length: 30 }, (_, i) => ok(`p${i}`)))
    render(<CheckSummary s={s} bar={96} label="#2: its checks" />)
    const bar = document.querySelector('[data-check-bar]')!
    expect(bar).toHaveAttribute('data-check-bar', 'fill')
    expect(bar.querySelectorAll('i')).toHaveLength(1)
    expect((bar as HTMLElement).style.width).toBe('96px')
  })
})
