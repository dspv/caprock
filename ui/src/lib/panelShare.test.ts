import { afterEach, describe, expect, it } from 'vitest'
import { Aliaser, HIDE_NAMES_KEY, hideNamesIn, isShareChrome, loadHideNames, mdTable, panelFileName, panelText, partsOf, saveHideNames, stripChrome } from './panelShare'

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

describe('a name in part', () => {
  it('sweeps a folder\'s last segment and a worktree\'s repository as the project', () => {
    expect(partsOf({ kind: 'folder', value: '/Users/me/dev/navige' })).toEqual([{ kind: 'project', value: 'navige' }])
    expect(partsOf({ kind: 'folder', value: '/Users/me/dev/navige/.claude/worktrees/agent-x' }))
      .toEqual([{ kind: 'project', value: 'navige' }, { kind: 'folder', value: 'agent-x' }])
    expect(partsOf({ kind: 'folder', value: 'C:\\dev\\navige' })).toEqual([{ kind: 'project', value: 'navige' }])
    expect(partsOf({ kind: 'project', value: 'octo/navige' })).toEqual([{ kind: 'person', value: 'octo' }, { kind: 'project', value: 'navige' }])
    expect(partsOf({ kind: 'branch', value: 'feat/navige' })).toEqual([])
    expect(partsOf({ kind: 'project', value: 'navige' })).toEqual([])
  })

  it('numbers the parts after the listed names, and finds them in any case', () => {
    const a = new Aliaser(true, [
      { kind: 'session', value: 'Fix the tail' }, { kind: 'folder', value: '/Users/me/dev/navige' }, { kind: 'project', value: 'octo/fleet' },
    ])
    expect(a.alias('project', 'octo/fleet')).toBe('project 1')
    expect(a.sweep('Navige and fleet by octo')).toBe('project 2 and project 3 by person 1')
    expect(a.sweep('dev/NAVIGE/src')).toBe('dev/project 2/src')
    expect(a.alias('project', 'Navige')).toBe('project 2')
  })
})

describe('an activity line', () => {
  it('hides file names, paths and branches, and still sweeps the names', () => {
    const a = new Aliaser(true, [{ kind: 'project', value: 'navige' }, { kind: 'branch', value: 'feat/tail' }])
    expect(a.activity('editing navige/internal/api/x.go')).toBe('editing path 1')
    expect(a.activity('editing README.md')).toBe('editing file 1')
    expect(a.activity('running git push origin feat/tail')).toBe('running git push origin branch 1')
    expect(a.activity('running git checkout fix/other-thing')).toBe('running git checkout path 2')
    expect(a.activity('searching for “Navige”')).toBe('searching for “project 1”')
    expect(a.activity('reading x.go.')).toBe('reading file 2.')
    // Counts and versions are not files.
    expect(a.activity('planning — 2/5 done')).toBe('planning — 2/5 done')
    expect(a.activity('running go test ./...')).toBe('running go test ./...')
    expect(a.activity('tagging v0.166.0')).toBe('tagging v0.166.0')
  })

  it('is left as it is with Hide project names off', () => {
    const a = new Aliaser(false, [{ kind: 'project', value: 'navige' }])
    expect(a.activity('editing navige/x.go')).toBe('editing navige/x.go')
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

describe('hideNamesIn, the marked parts', () => {
  it('replaces a data-share-name element whole and hides paths in data-share-activity lines', () => {
    const root = document.createElement('section')
    root.innerHTML = '<h2 data-share-keep>Live pulse</h2>'
      + '<div id="row"><b>navige</b> <span id="br" data-share-name="branch">release/<i>late</i></span>'
      + ' · <span id="act" data-share-activity>editing navige/src/Tail.tsx</span></div>'
      + '<p id="other">Tail.tsx in Navige</p>'
    hideNamesIn(root, new Aliaser(true, [{ kind: 'project', value: 'navige' }]))
    expect(root.querySelector('#br')!.textContent).toBe('branch 1')
    expect(root.querySelector('#act')!.textContent).toBe('editing path 1')
    expect(root.querySelector('#row')!.textContent).toBe('project 1 branch 1 · editing path 1')
    expect(root.querySelector('#other')!.textContent).toBe('Tail.tsx in project 1')
  })

  it('touches nothing with Hide project names off', () => {
    const root = document.createElement('section')
    root.innerHTML = '<span data-share-name="branch">main</span><span data-share-activity>editing x.go</span>'
    hideNamesIn(root, new Aliaser(false, [{ kind: 'project', value: 'navige' }]))
    expect(root.textContent).toBe('mainediting x.go')
  })
})

describe('chrome', () => {
  it('takes out the share button, skipped controls, tooltips and hover-only buttons, and keeps the content', () => {
    const root = document.createElement('section')
    root.innerHTML = '<header><h2 data-share-keep><button><span data-share-skip>›</span>Repos</button></h2>'
      + '<button data-panel-share>share</button></header>'
      + '<div><button data-share-skip>More</button><span>navige</span><span role="tooltip">what it means</span>'
      + '<button class="opacity-0 group-hover:opacity-100">Hide</button><button class="opacity-50">7d</button>'
      + '<span data-stat-hint>hint</span></div>'
    expect(isShareChrome(root.querySelector('[data-panel-share]')!)).toBe(true)
    expect(isShareChrome(root.querySelector('.opacity-50')!)).toBe(false)
    expect(isShareChrome(document.createTextNode('x'))).toBe(false)
    stripChrome(root)
    expect(root.textContent).toBe('Reposnavige7d')
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
