import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommandPalette, rank, score, type PaletteItem } from './CommandPalette'

const item = (id: string, group: PaletteItem['group'], label: string, detail?: string): PaletteItem => ({ id, group, label, detail, run: () => {} })

describe('the command palette ranking', () => {
  it('scores a prefix over a word start over a substring over the detail', () => {
    expect(score('fix', item('a', 'Sessions', 'Fix login'))).toBe(4)
    expect(score('log', item('a', 'Sessions', 'Fix login'))).toBe(3)
    expect(score('ogi', item('a', 'Sessions', 'Fix login'))).toBe(2)
    expect(score('caprock', item('a', 'Sessions', 'Fix login', 'caprock · main'))).toBe(1)
    expect(score('nope', item('a', 'Sessions', 'Fix login'))).toBe(0)
  })

  it('keeps the group order with no query, and puts the group with the best match first with one', () => {
    const items = [
      item('1', 'Actions', 'New shell'),
      item('2', 'Projects', 'shellcheck'),
      item('3', 'Waiting', 'Deploy', 'web'),
    ]
    expect(rank(items, '').map((i) => i.id)).toEqual(['3', '1', '2'])
    expect(rank(items, 'shell').map((i) => i.id)).toEqual(['2', '1'])
  })
})

describe('the palette over history', () => {
  it('finds a past session on the daemon, under History, instead of offering a new agent', async () => {
    const search = vi.fn(async () => [item('s-old', 'History', 'Webhook retries', 'api · 8d ago')])
    const fallback = vi.fn(() => item('new-task', 'Actions', 'New agent on it'))
    render(<CommandPalette items={[item('a', 'Actions', 'New shell')]} search={search} fallback={fallback} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'webhook' } })
    expect(await screen.findByText('Webhook retries')).toBeTruthy()
    expect(screen.getByText('History')).toBeTruthy()
    expect(screen.queryByText('New agent on it')).toBeNull()
    expect(search).toHaveBeenCalledWith('webhook')
  })
})
