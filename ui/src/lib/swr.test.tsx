/**
 * Stale-while-revalidate for the slow figures (lib/swr.ts). What matters: the
 * last answer shows at once, marked stale; the fresh one replaces it; and
 * nothing a browser's storage can do — garbage, an oversized entry, an
 * exception — reaches the screen as anything but "no copy".
 */
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApi } from './useApi'
import { CACHE_VERSION, MAX_ENTRY, readCache, writeCache } from './swr'

vi.mock('./live', () => ({ useLiveTick: () => 0 }))

const KEY = `caprock-swr-v${CACHE_VERSION}:summary:today:all`

function Probe({ fetcher }: { fetcher: () => Promise<{ cost: number }> }) {
  const q = useApi(fetcher, [], { cache: 'summary:today:all' })
  return (
    <div>
      <span data-testid="cost">{q.data ? String(q.data.cost) : 'none'}</span>
      <span data-testid="stale">{q.stale ? `stale@${q.cachedAt}` : 'fresh'}</span>
    </div>
  )
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('stale-while-revalidate', () => {
  it('shows the kept answer at once, marked stale, then the fresh one', async () => {
    localStorage.setItem(KEY, JSON.stringify({ data: { cost: 3 }, at: 1234 }))
    let release: (v: { cost: number }) => void = () => {}
    const fetcher = vi.fn(() => new Promise<{ cost: number }>((res) => { release = res }))
    render(<Probe fetcher={fetcher} />)
    expect(screen.getByTestId('cost').textContent).toBe('3')
    expect(screen.getByTestId('stale').textContent).toBe('stale@1234')

    await act(async () => release({ cost: 7 }))
    expect(screen.getByTestId('cost').textContent).toBe('7')
    expect(screen.getByTestId('stale').textContent).toBe('fresh')
    expect(readCache<{ cost: number }>('summary:today:all')?.data.cost).toBe(7)
  })

  it('ignores a corrupted or oversized entry', async () => {
    const fetcher = () => new Promise<{ cost: number }>(() => {})
    for (const raw of ['{not json', JSON.stringify({ data: { cost: 1 } }), JSON.stringify({ at: 5 }), 'x'.repeat(MAX_ENTRY + 1)]) {
      localStorage.setItem(KEY, raw)
      const { unmount } = render(<Probe fetcher={fetcher} />)
      expect(screen.getByTestId('cost').textContent).toBe('none')
      expect(screen.getByTestId('stale').textContent).toBe('fresh')
      unmount()
    }
  })

  it('does not keep an answer too big to keep, and drops the older one', () => {
    writeCache('big', { v: 1 })
    expect(readCache('big')).toBeDefined()
    writeCache('big', { v: 'x'.repeat(MAX_ENTRY) })
    expect(readCache('big')).toBeUndefined()
  })

  it('works with storage that throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    render(<Probe fetcher={() => Promise.resolve({ cost: 9 })} />)
    await act(async () => {})
    expect(screen.getByTestId('cost').textContent).toBe('9')
    expect(screen.getByTestId('stale').textContent).toBe('fresh')
  })

  it('keeps only the 30 most recently viewed sessions', () => {
    for (let i = 0; i < 35; i++) writeCache(`session:s${i}`, { n: i }, 1000 + i)
    expect(readCache('session:s4')).toBeUndefined()
    expect(readCache('session:s5')).toBeDefined()
    expect(readCache('session:s34')).toBeDefined()
  })

  it('holds the total under its cap by dropping the oldest', () => {
    const chunk = 'y'.repeat(MAX_ENTRY - 100)
    for (let i = 0; i < 8; i++) writeCache(`k${i}`, chunk, 1000 + i)
    // 8 × ~200k is over the 1M cap: the oldest went first, the newest stayed.
    expect(readCache('k0')).toBeUndefined()
    expect(readCache('k7')).toBeDefined()
  })
})
