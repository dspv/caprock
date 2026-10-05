import { describe, expect, it } from 'vitest'
import { rank, score, type PaletteItem } from './CommandPalette'

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
