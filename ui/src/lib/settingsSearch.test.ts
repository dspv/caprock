/**
 * Settings search: titles first, then synonyms, then the text inside a
 * section; the control a hit names is what a jump lands on.
 */
import { describe, expect, it } from 'vitest'
import { findTarget, fold, indexPage, searchSections, type SectionIndex } from './settingsSearch'

const page: SectionIndex[] = [
  { id: 'phone', title: 'Use on your phone', entries: ['Show a pairing code'] },
  { id: 'telegram', title: 'Telegram', entries: ['Paste the bot token', 'When a session has finished'] },
  { id: 'appearance', title: 'Appearance', entries: ['Sidebar', 'Projects', 'Tabs'] },
  { id: 'github', title: 'GitHub', entries: ['Paste a token with repo scope'] },
  { id: 'hotkey', title: 'Global shortcut', entries: ['Bring Caprock to the front'] },
]

const ids = (q: string) => searchSections(page, q).map((m) => m.id)

describe('searchSections', () => {
  it('finds nothing for an empty query', () => {
    expect(searchSections(page, '  ')).toEqual([])
  })

  it('ranks a title over the text inside another section', () => {
    expect(ids('github')).toEqual(['github'])
    expect(ids('tele')).toEqual(['telegram'])
  })

  it('maps the words people type to the section that holds them', () => {
    expect(ids('token')).toEqual(['telegram', 'github'])
    expect(ids('dark')).toEqual(['appearance'])
    expect(ids('theme')).toEqual(['appearance'])
    expect(ids('phone')[0]).toBe('phone')
    expect(ids('keys')).toEqual(['hotkey'])
    expect(ids('shortcut')).toEqual(['hotkey'])
  })

  it('names the text inside that matched', () => {
    const m = searchSections(page, 'has finished')
    expect(m).toEqual([{ id: 'telegram', title: 'Telegram', hit: 'When a session has finished' }])
  })

  it('needs every word, each anywhere in the section', () => {
    expect(ids('session finished')).toEqual(['telegram'])
    expect(ids('session sidebar')).toEqual([])
  })

  it('ignores case and accents', () => {
    expect(fold('  Ápp  Éar ')).toBe('app ear')
    expect(ids('APPEARANCE')).toEqual(['appearance'])
    expect(ids('appéarance')).toEqual(['appearance'])
  })

  it('says nothing matches with an empty list', () => {
    expect(ids('zzzz')).toEqual([])
  })
})

describe('indexPage and findTarget', () => {
  it('reads titles, texts and named controls; a folded section keeps what it said', () => {
    document.body.innerHTML = `
      <div id="root">
        <section id="s-a" data-settings-section="Telegram">
          <header><button aria-expanded="true">Telegram</button><button data-explain-toggle title="What do these do?">?</button></header>
          <label><input type="checkbox"><span>When a session has finished</span></label>
          <input aria-label="Bot token" placeholder="Paste the bot token">
        </section>
        <section id="s-b" data-settings-section="Appearance">
          <header><button aria-expanded="false">Appearance</button></header>
        </section>
      </div>`
    const root = document.getElementById('root')!
    const idx = indexPage(root)
    expect(idx.map((s) => s.title)).toEqual(['Telegram', 'Appearance'])
    expect(idx[0]!.entries).toContain('When a session has finished')
    expect(idx[0]!.entries).toContain('Paste the bot token')
    // The ? on every section is not a reason to find them all.
    expect(idx[0]!.entries).not.toContain('What do these do?')
    expect(idx[1]!.entries).toEqual([])

    // Fold the first: it is still found by what it said.
    root.querySelector('#s-a header [aria-expanded]')!.setAttribute('aria-expanded', 'false')
    for (const el of root.querySelectorAll('#s-a > :not(header)')) el.remove()
    expect(indexPage(root)[0]!.entries).toContain('When a session has finished')
  })

  it('lands on the label a hit names, opening a details it is folded in', () => {
    document.body.innerHTML = `
      <section id="s">
        <details><summary>More</summary><label id="l"><span>Keep the last reply</span></label></details>
      </section>`
    const s = document.getElementById('s')!
    // jsdom draws nothing; give every element a box so it counts as shown.
    const proto = Element.prototype as unknown as { getClientRects: () => unknown }
    const was = proto.getClientRects
    proto.getClientRects = () => [{}]
    try {
      expect(findTarget(s, 'last reply').id).toBe('l')
      expect((s.querySelector('details') as HTMLDetailsElement).open).toBe(true)
      expect(findTarget(s, 'not here')).toBe(s)
      expect(findTarget(s)).toBe(s)
    } finally {
      proto.getClientRects = was
    }
  })
})
