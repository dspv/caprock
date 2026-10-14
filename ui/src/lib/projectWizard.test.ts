import { describe, expect, it } from 'vitest'
import {
  createLabel, createRequests, expandTilde, foundHeadline, foundOf, instructionsState, instructionsSummary, lineCount, listedAt,
  membersLine, parentOf, placeChips, repoFilesLabel, splitMemberFile,
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
    expect(createRequests(f, ['/w/api', '/w/web'], 'one')).toEqual([{ path: '/w', repos: ['/w/api', '/w/web'] }])
    expect(createRequests(f, ['/w/api', '/w/web'], 'separate')).toEqual([{ path: '/w/api' }, { path: '/w/web' }])
    expect(createRequests(f, ['/w/web'], 'one')).toEqual([{ path: '/w/web' }])
    expect(createRequests(f, [], 'one')).toBe('Pick at least one repository.')
    expect(createLabel(f, 3, 'one', false)).toBe('Create project of 3 repos')
    expect(createLabel(f, 3, 'separate', false)).toBe('Create 3 projects')
    expect(createLabel(f, 1, 'one', false)).toBe('Create project')
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
