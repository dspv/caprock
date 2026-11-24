import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { useContext, useEffect, useState } from 'react'
import { KeptViews } from './KeptViews'
import { ScreenShown } from '@/lib/refresh'

/** A view that counts its mounts and its effect runs, and holds a typed value. */
const mounts: Record<string, number> = {}
const effects: Record<string, number> = {}
function View({ id }: { id: string }) {
  const [held] = useState(() => { mounts[id] = (mounts[id] ?? 0) + 1; return `held ${id}` })
  const shown = useContext(ScreenShown)
  useEffect(() => { effects[id] = (effects[id] ?? 0) + 1 }, [])
  return <p data-testid={`v-${id}`} data-shown={String(shown)}>{held}</p>
}

function Host({ current, alive, keep }: { current?: string; alive?: (k: string) => boolean; keep?: number }) {
  return <KeptViews current={current} alive={alive} keep={keep}>{current && <View id={current} />}</KeptViews>
}

const shownOf = (id: string) => screen.queryByTestId(`v-${id}`)

describe('KeptViews', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    for (const k of Object.keys(mounts)) delete mounts[k]
    for (const k of Object.keys(effects)) delete effects[k]
  })
  afterEach(() => vi.useRealTimers())

  it('a view switched back to is the same one, not mounted again', () => {
    const { rerender } = render(<Host current="a" />)
    rerender(<Host current="b" />)
    rerender(<Host current="a" />)
    expect(mounts).toEqual({ a: 1, b: 1 })
    // Only the one in front is displayed and told it is shown.
    expect(shownOf('a')!.parentElement!.style.display).toBe('contents')
    expect(shownOf('b')!.parentElement!.style.display).toBe('none')
    expect(shownOf('a')!.dataset.shown).toBe('true')
    expect(shownOf('b')!.dataset.shown).toBe('false')
  })

  it('a hidden view stays live for its grace, then its effects are torn down and run again when shown', () => {
    const { rerender } = render(<Host current="a" />)
    rerender(<Host current="b" />)
    rerender(<Host current="a" />)
    // Back within the grace: its effects never went.
    expect(effects.a).toBe(1)
    rerender(<Host current="b" />)
    act(() => { vi.advanceTimersByTime(31_000) })
    rerender(<Host current="a" />)
    expect(effects.a).toBe(2)
    expect(mounts.a).toBe(1)
  })

  it('keeps at most `keep`, dropping the one shown longest ago', () => {
    const { rerender } = render(<Host current="a" keep={2} />)
    act(() => { vi.advanceTimersByTime(10) })
    rerender(<Host current="b" keep={2} />)
    act(() => { vi.advanceTimersByTime(10) })
    rerender(<Host current="c" keep={2} />)
    expect(shownOf('a')).toBeNull()
    expect(shownOf('b')).not.toBeNull()
    rerender(<Host current="a" keep={2} />)
    expect(mounts.a).toBe(2)
  })

  it('drops a view whose tab closed, and one hidden past ten minutes', () => {
    let open = new Set(['a', 'b'])
    const alive = (k: string) => open.has(k)
    const { rerender } = render(<Host current="a" alive={alive} />)
    rerender(<Host current="b" alive={alive} />)
    expect(shownOf('a')).not.toBeNull()
    open = new Set(['b'])
    rerender(<Host current="b" alive={(k) => open.has(k)} />)
    expect(shownOf('a')).toBeNull()
    rerender(<Host current="c" alive={() => true} />)
    expect(shownOf('b')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(10 * 60_000 + 1_000) })
    expect(shownOf('b')).toBeNull()
  })

  it('nothing in front keeps every view hidden', () => {
    const { rerender } = render(<Host current="a" />)
    rerender(<Host />)
    expect(shownOf('a')!.parentElement!.style.display).toBe('none')
  })
})
