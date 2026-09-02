import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { useApi } from './useApi'

// The hook subscribes to a live tick; without a stub every test would sit and
// wait for a real interval to fire.
vi.mock('./live', () => ({ useLiveTick: () => 0 }))

function Probe({ range, fetcher }: { range: string; fetcher: (r: string) => Promise<string> }) {
  const q = useApi(() => fetcher(range), [range])
  return (
    <div>
      <span data-testid="heading">Totals · {range}</span>
      <span data-testid="body">{q.loading ? 'reading…' : (q.data ?? 'nothing')}</span>
      <button onClick={q.refresh}>refresh</button>
    </div>
  )
}

describe('useApi', () => {
  beforeEach(() => vi.useRealTimers())
  afterEach(() => vi.restoreAllMocks())

  // The defect this hook shipped with: the heading is the new range and every
  // figure under it is still the old range's answer, for as long as the
  // request takes. On a large database that is around half a second — long
  // enough to read a number and believe it.
  it('does not show the previous answer under a new question', async () => {
    let release: (v: string) => void = () => {}
    const fetcher = vi.fn((r: string) =>
      r === '30d'
        ? Promise.resolve('thirty')
        : new Promise<string>((res) => { release = res }),
    )

    const { rerender } = render(<Probe range="30d" fetcher={fetcher} />)
    await act(async () => {})
    expect(screen.getByTestId('body').textContent).toBe('thirty')

    // Ask a different question; its answer has not arrived yet.
    rerender(<Probe range="7d" fetcher={fetcher} />)
    await act(async () => {})

    expect(screen.getByTestId('heading').textContent).toBe('Totals · 7d')
    expect(screen.getByTestId('body').textContent).toBe('reading…')
    expect(screen.getByTestId('body').textContent).not.toBe('thirty')

    await act(async () => { release('seven') })
    expect(screen.getByTestId('body').textContent).toBe('seven')
  })

  // The other half of the rule. A refresh is the same question asked again, so
  // blanking the screen for it would make a live dashboard flicker every few
  // seconds — which is why this cannot simply clear on every run.
  it('keeps the figures on screen while a refresh reloads them', async () => {
    let release: (v: string) => void = () => {}
    let call = 0
    const fetcher = vi.fn(() => {
      call++
      return call === 1
        ? Promise.resolve('first')
        : new Promise<string>((res) => { release = res })
    })

    render(<Probe range="30d" fetcher={fetcher} />)
    await act(async () => {})
    expect(screen.getByTestId('body').textContent).toBe('first')

    await act(async () => { screen.getByText('refresh').click() })
    expect(screen.getByTestId('body').textContent).toBe('first')

    await act(async () => { release('second') })
    expect(screen.getByTestId('body').textContent).toBe('second')
  })

  // Two questions in flight at once must resolve to the one asked last, not the
  // one that happened to answer last.
  it('ignores an answer to a question that has been superseded', async () => {
    const pending: Record<string, (v: string) => void> = {}
    const fetcher = vi.fn(
      (r: string) => new Promise<string>((res) => { pending[r] = res }),
    )

    const { rerender } = render(<Probe range="30d" fetcher={fetcher} />)
    await act(async () => {})
    rerender(<Probe range="7d" fetcher={fetcher} />)
    await act(async () => {})

    // The slow 30d request lands after the 7d one was asked for.
    await act(async () => { pending['30d']?.('thirty') })
    expect(screen.getByTestId('body').textContent).toBe('reading…')

    await act(async () => { pending['7d']?.('seven') })
    expect(screen.getByTestId('body').textContent).toBe('seven')
  })
})
