import { describe, expect, it } from 'vitest'
import { foldSearch, matchRanges } from './brainsearch'

const marked = (text: string, terms: string[]) => matchRanges(text, terms).map(([a, b]) => text.slice(a, b))

describe('foldSearch', () => {
  it('folds as the daemon does', () => {
    expect(foldSearch('ΑΘΗΝΑ')).toBe('αθηνα')
    expect(foldSearch('Αθήνα')).toBe('αθηνα')
    expect(foldSearch('ΟΔΟΣ')).toBe('οδοσ')
    expect(foldSearch('οδός')).toBe('οδοσ')
    expect(foldSearch('CAFÉ')).toBe('cafe')
    expect(foldSearch('Ｗｉｄｅ')).toBe('wide')
    expect(foldSearch('東京タワー')).toBe('東京タワー')
  })
})

describe('matchRanges', () => {
  it('marks the original letters a folded term matched', () => {
    expect(marked('Move the office to Αθήνα', ['αθηνα'])).toEqual(['Αθήνα'])
    expect(marked('The Café on the corner', ['cafe'])).toEqual(['Café'])
    expect(marked('東京タワーの設計', ['タワー'])).toEqual(['タワー'])
  })

  it('marks every term, each occurrence, merging overlaps', () => {
    expect(marked('Keep WAL, keep it', ['keep', 'wal'])).toEqual(['Keep', 'WAL', 'keep'])
    expect(marked('routers', ['route', 'router'])).toEqual(['router'])
  })

  it('maps through characters that fold to several', () => {
    // "ﬁ" folds to "fi": the ligature is marked whole.
    expect(marked('ﬁle on disk', ['file'])).toEqual(['ﬁle'])
    // An emoji is two UTF-16 units; the offsets after it stay right.
    expect(marked('🚀 launch', ['launch'])).toEqual(['launch'])
  })

  it('marks nothing without terms', () => {
    expect(matchRanges('anything', [])).toEqual([])
    expect(matchRanges('anything', undefined)).toEqual([])
    expect(matchRanges('', ['a'])).toEqual([])
  })
})
