import { afterEach, describe, expect, it } from 'vitest'
import { Aliaser, HIDE_NAMES_KEY, hideNamesIn, loadHideNames, mdTable, panelFileName, panelText, saveHideNames } from './panelShare'

afterEach(() => localStorage.clear())

describe('Aliaser', () => {
  it('numbers each kind in the order the panel lists its names, the same stand-in every time', () => {
    const a = new Aliaser(true, [
      { kind: 'project', value: 'caprock' }, { kind: 'branch', value: 'feat/share-any-panel' },
      { kind: 'project', value: 'caprock-web' }, { kind: 'session', value: 'Fix the tail' }, { kind: 'project', value: 'caprock' },
    ])
    expect(a.alias('project', 'caprock')).toBe('project 1')
    expect(a.alias('project', 'caprock-web')).toBe('project 2')
    expect(a.alias('branch', 'feat/share-any-panel')).toBe('branch 1')
    expect(a.alias('session', 'Fix the tail')).toBe('session 1')
    // A name not listed still gets the next number, consistently.
    expect(a.alias('project', 'navige')).toBe('project 3')
    expect(a.alias('project', 'navige')).toBe('project 3')
  })

  it('is the identity with Hide project names off', () => {
    const a = new Aliaser(false, [{ kind: 'project', value: 'caprock' }])
    expect(a.alias('project', 'caprock')).toBe('caprock')
    expect(a.sweep('caprock on main')).toBe('caprock on main')
  })

  it('sweeps whole names only, longest first, beside slashes and dots', () => {
    const a = new Aliaser(true, [
      { kind: 'project', value: 'ui' }, { kind: 'folder', value: '/Users/me/dev/caprock' }, { kind: 'project', value: 'caprock' },
    ])
    expect(a.sweep('build ui and guide')).toBe('build project 1 and guide')
    expect(a.sweep('/Users/me/dev/caprock')).toBe('folder 1')
    expect(a.sweep('dev/caprock.')).toBe('dev/project 2.')
    expect(a.sweep('caprock-web')).toBe('caprock-web')
  })

  it('never sweeps a one-letter name out of ordinary words', () => {
    const a = new Aliaser(true, [{ kind: 'project', value: 'a' }])
    expect(a.sweep('a cost of a day')).toBe('a cost of a day')
    expect(a.alias('project', 'a')).toBe('project 1')
  })
})

describe('hideNamesIn', () => {
  it('rewrites every text node but the panel title', () => {
    const root = document.createElement('section')
    root.innerHTML = '<h2 data-share-keep>Repos</h2><div><span>Repos</span> <b>caprock</b> on <i>main</i> · $4.20</div>'
    const a = new Aliaser(true, [{ kind: 'project', value: 'Repos' }, { kind: 'project', value: 'caprock' }, { kind: 'branch', value: 'main' }])
    hideNamesIn(root, a)
    expect(root.querySelector('h2')!.textContent).toBe('Repos')
    expect(root.querySelector('div')!.textContent).toBe('project 1 project 2 on branch 1 · $4.20')
  })
})

describe('the rest', () => {
  it('remembers Hide project names per viewer, on by default', () => {
    expect(loadHideNames()).toBe(true)
    saveHideNames(false)
    expect(localStorage.getItem(HIDE_NAMES_KEY)).toBe('off')
    expect(loadHideNames()).toBe(false)
  })

  it('writes a Markdown table with pipes escaped', () => {
    expect(mdTable(['A', 'B'], [['x|y', 2]])).toBe('| A | B |\n| --- | --- |\n| x\\|y | 2 |')
  })

  it('names the file and heads the text', () => {
    const at = new Date(2026, 9, 28, 9, 5)
    expect(panelFileName('Live pulse', at)).toBe('caprock-live-pulse-2026-10-28.png')
    expect(panelFileName('Totals · 30d', at)).toBe('caprock-totals-30d-2026-10-28.png')
    expect(panelText('Repos', 'body', at)).toBe('## Repos\n\nbody\n\n28 Oct 2026, 09:05 · via caprock.dev\n')
  })
})
