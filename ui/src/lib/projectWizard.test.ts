import { describe, expect, it } from 'vitest'
import {
  createLabel, createRequests, drillPath, expandTilde, filterFolders, foundHeadline, foundOf, homeOf, instructionsState, instructionsSummary, lineCount, listedAt,
  membersLine, parentOf, pickedLabel, placeChips, repoFilesLabel, splitMemberFile, splitTyped, suggestedName, togglePick, wholeFolder, type Found,
} from './projectWizard'
import type { Project } from './projects'

const home = '/Users/ada'

describe('the places offered as one click', () => {
  it('ranks the folders projects live in, then the default folder, home last', () => {
    const roots = ['/Users/ada/dev/a', '/Users/ada/dev/b', '/Users/ada/work/c', '/Users/ada/dev/d', '/srv/x']
    expect(placeChips(roots, { home, defaultFolder: '~/code' })).toEqual(['~/dev', '~/work', '/srv', '~/code', '~'])
  })
  it('never offers the filesystem root, and caps the list with home kept', () => {
    expect(placeChips(['/top', '/a/b', '/c/d', '/e/f', '/g/h', '/i/j'], { home, limit: 3 })).toEqual(['/a', '/c', '~'])
  })
  it('is home alone on a fresh machine', () => {
    expect(placeChips([], { home })).toEqual(['~'])
  })
})

describe('paths', () => {
  it('finds a parent and expands ~', () => {
    expect(parentOf('/a/b/')).toBe('/a')
    expect(parentOf('/a')).toBe('/')
    expect(expandTilde('~/dev', home)).toBe('/Users/ada/dev')
    expect(expandTilde('~', home)).toBe('/Users/ada')
    expect(expandTilde('/x', home)).toBe('/x')
  })
})

describe('what a scan found', () => {
  it('a folder inside a repository is that repository, nothing to choose', () => {
    const f = foundOf({ root: '/w/api/src', repo_root: '/w/api', repos: [] })
    expect(f).toEqual({ kind: 'repo', path: '/w/api', name: 'api', inside: true })
    expect(foundHeadline(f)).toBe('One repository')
    expect(createRequests(f, [], 'one')).toEqual([{ path: '/w/api' }])
  })

  it('several repositories: one project of the picked ones, or one each, or one alone', () => {
    const f = foundOf({ root: '/w', repos: [{ path: '/w/api', name: 'api' }, { path: '/w/web', name: 'web' }, { path: '/w/infra', name: 'infra' }] })
    expect(f.kind).toBe('multi')
    expect(foundHeadline(f, 3)).toBe('3 repositories')
    expect(foundHeadline(f, 2)).toBe('3 repositories · 2 picked')
    // Some of a folder's repositories: no folder of its own, the first picked is home (ADR-077).
    expect(createRequests(f, ['/w/api', '/w/web'], 'one')).toEqual([{ repos: ['/w/api', '/w/web'] }])
    expect(createRequests(f, ['/w/api', '/w/web'], 'one', ' Suite ')).toEqual([{ repos: ['/w/api', '/w/web'], name: 'Suite' }])
    expect(homeOf(f, ['/w/web', '/w/api'])).toBe('/w/web')
    expect(suggestedName(f, ['/w/web', '/w/api'])).toBe('web')
    // All of them: the folder is the project (ADR-055).
    expect(createRequests(f, ['/w/api', '/w/web', '/w/infra'], 'one')).toEqual([{ path: '/w', repos: ['/w/api', '/w/web', '/w/infra'] }])
    expect(homeOf(f, ['/w/api', '/w/web', '/w/infra'])).toBe('/w')
    expect(createRequests(f, ['/w/api', '/w/web'], 'separate')).toEqual([{ path: '/w/api' }, { path: '/w/web' }])
    expect(createRequests(f, ['/w/web'], 'one')).toEqual([{ path: '/w/web' }])
    expect(createRequests(f, [], 'one')).toBe('Pick at least one repository.')
    expect(createLabel(f, 3, 'one', false)).toBe('Create project of 3 repos')
    expect(createLabel(f, 3, 'separate', false)).toBe('Create 3 projects')
    expect(createLabel(f, 1, 'one', false)).toBe('Create project')
  })

  it('a repository already in another project does not stop the folder being the project', () => {
    const f = foundOf({ root: '/w', repos: [{ path: '/w/api', name: 'api' }, { path: '/w/web', name: 'web' }, { path: '/w/old', name: 'old', member_of: 9 }] })
    expect(wholeFolder(f, ['/w/api', '/w/web'])).toBe(true)
    expect(createRequests(f, ['/w/api', '/w/web'], 'one')).toEqual([{ path: '/w', repos: ['/w/api', '/w/web'] }])
  })

  it('repositories ticked one by one, from anywhere, are one project with the first as home', () => {
    let picks = togglePick(new Map(), 'C:\\dev\\ai-crm', 'ai-crm')
    expect(pickedLabel(picks.size)).toBe('1 selected · tick one more')
    picks = togglePick(picks, 'D:\\work\\ai-notary', 'ai-notary')
    expect(pickedLabel(picks.size)).toBe('2 selected · Continue')
    expect(pickedLabel(togglePick(picks, 'C:\\dev\\ai-crm', 'ai-crm').size)).toBe('1 selected · tick one more')
    expect(pickedLabel(0)).toBe('Tick two or more')
    const f: Found = { kind: 'chosen', repos: [...picks].map(([path, name]) => ({ path, name })) }
    expect(foundHeadline(f, 2)).toBe('2 repositories, one project')
    expect(createRequests(f, [...picks.keys()], 'one')).toEqual([{ repos: ['C:\\dev\\ai-crm', 'D:\\work\\ai-notary'] }])
    expect(createLabel(f, 2, 'one', false)).toBe('Create project of 2 repos')
    expect(suggestedName(f, [...picks.keys()])).toBe('ai-crm')
  })

  it('one repository below the folder is looked at itself; none is a plain folder', () => {
    expect(foundOf({ root: '/w', repos: [{ path: '/w/api', name: 'api' }] }).kind).toBe('one-below')
    const f = foundOf({ root: '/w/notes', repos: [] })
    expect(f).toEqual({ kind: 'folder', path: '/w/notes', name: 'notes' })
    expect(foundHeadline(f)).toBe('A plain folder')
  })

  it('a folder already listed opens rather than adds', () => {
    const projects = [{ id: '1', root: '/w/api', name: 'api', kind: 'repo' }] as Project[]
    expect(listedAt(projects, '/w/api/')?.id).toBe('1')
    expect(createLabel({ kind: 'repo', path: '/w/api', name: 'api', inside: false }, 0, 'one', true)).toBe('Open project')
  })
})

describe('instructions at a glance', () => {
  it('counts lines, a trailing newline not one', () => {
    expect(lineCount('')).toBe(0)
    expect(lineCount('a\nb\n\n')).toBe(2)
    expect(instructionsState('one')).toEqual({ set: true, label: 'Set · 1 line' })
    expect(instructionsState('a\nb\nc')).toEqual({ set: true, label: 'Set · 3 lines' })
    expect(instructionsState('   ')).toEqual({ set: false, label: 'None' })
  })

  it('names the repository files, members grouped', () => {
    expect(repoFilesLabel(['CLAUDE.md', 'AGENTS.md'])).toBe('CLAUDE.md · AGENTS.md')
    expect(repoFilesLabel(['.claude/CLAUDE.md', 'api/CLAUDE.md', 'web/CLAUDE.md', 'web/AGENTS.md'])).toBe('.claude/CLAUDE.md · CLAUDE.md in api, web · AGENTS.md in web')
    expect(splitMemberFile('services/web/.claude/CLAUDE.md')).toEqual({ member: 'services/web', name: '.claude/CLAUDE.md' })
  })

  it('says set, the repository’s own, or none', () => {
    expect(instructionsSummary({ defaults: { system_prompt: 'a\nb' }, instruction_files: ['CLAUDE.md'] })).toEqual({ kind: 'set', text: 'Instructions: set · 2 lines · repo has CLAUDE.md' })
    expect(instructionsSummary({ instruction_files: ['AGENTS.md'] })).toEqual({ kind: 'repo', text: 'Instructions: none from Caprock · repo has AGENTS.md' })
    expect(instructionsSummary({})).toEqual({ kind: 'none', text: 'Instructions: none' })
  })

  it('names a multi-repo project’s members', () => {
    expect(membersLine([{ name: 'api' }, { name: 'web' }, { name: 'infra' }])).toBe('3 repos: api, web, infra')
    expect(membersLine([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 2)).toBe('3 repos: a, b +1')
    expect(membersLine(undefined)).toBe('')
  })
})

describe('typing a name in the folder field', () => {
  it('splits the folder being listed from the name being typed', () => {
    expect(splitTyped('~/dev/cap')).toEqual({ dir: '~/dev/', partial: 'cap' })
    expect(splitTyped('~/dev/')).toEqual({ dir: '~/dev/', partial: '' })
    expect(splitTyped('  ~/dev/ca ')).toEqual({ dir: '~/dev/', partial: 'ca' })
    expect(splitTyped('~')).toEqual({ dir: '~', partial: '' })
    expect(splitTyped('~/d')).toEqual({ dir: '~/', partial: 'd' })
    expect(splitTyped('/Users/ada/dev/x')).toEqual({ dir: '/Users/ada/dev/', partial: 'x' })
    expect(splitTyped('cap')).toEqual({ dir: '', partial: 'cap' })
    expect(splitTyped('')).toEqual({ dir: '', partial: '' })
  })

  it('splits Windows paths: backslashes, drive letters, ~\\', () => {
    expect(splitTyped('C:\\Users\\ada\\de')).toEqual({ dir: 'C:\\Users\\ada\\', partial: 'de' })
    expect(splitTyped('C:\\')).toEqual({ dir: 'C:\\', partial: '' })
    expect(splitTyped('C:')).toEqual({ dir: 'C:\\', partial: '' })
    expect(splitTyped('d:\\Wo')).toEqual({ dir: 'd:\\', partial: 'Wo' })
    expect(splitTyped('~\\dev\\cap')).toEqual({ dir: '~\\dev\\', partial: 'cap' })
    expect(splitTyped('C:/Users/ada')).toEqual({ dir: 'C:/Users/', partial: 'ada' })
  })

  const entries = [
    { name: 'ai-crm' }, { name: 'Caprock' }, { name: 'caprock-web' }, { name: 'escape' }, { name: 'notes' }, { name: 'recap' },
  ]
  it('keeps the names that start with it first, then the ones that hold it, ignoring case', () => {
    const got = filterFolders(entries, 'cap')
    expect(got.map((m) => m.entry.name)).toEqual(['Caprock', 'caprock-web', 'escape', 'recap'])
    expect(got.map((m) => [m.start, m.length])).toEqual([[0, 3], [0, 3], [2, 3], [2, 3]])
    expect(filterFolders(entries, 'CAP').map((m) => m.entry.name)).toEqual(['Caprock', 'caprock-web', 'escape', 'recap'])
  })

  it('an empty name lists everything, unmarked; no match lists nothing', () => {
    expect(filterFolders(entries, '')).toHaveLength(6)
    expect(filterFolders(entries, '').every((m) => m.length === 0)).toBe(true)
    expect(filterFolders(entries, 'zzz')).toEqual([])
  })

  it('Tab drills in: the folder in ~ form and its own separator', () => {
    expect(drillPath('/Users/ada/dev/caprock', home)).toBe('~/dev/caprock/')
    expect(drillPath('/srv/x', home)).toBe('/srv/x/')
    expect(drillPath('C:\\Users\\ada\\dev\\caprock', 'C:\\Users\\ada')).toBe('~\\dev\\caprock\\')
    expect(drillPath('D:\\work', 'C:\\Users\\ada')).toBe('D:\\work\\')
  })
})
