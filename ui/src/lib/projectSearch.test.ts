import { describe, expect, it } from 'vitest'
import { closest, matchName, mergeCandidates, queryOf, rankCandidates, tildePath, type Candidate } from './projectSearch'

const c = (kind: Candidate['kind'], path: string): Candidate => ({ kind, path, name: path.split('/').pop()! })

describe('project search', () => {
  const all = mergeCandidates([
    [{ ...c('project', '/h/dev/caprock'), projectId: '1' }],
    [c('recent', '/h/dev/caprock'), c('recent', '/h/dev/notes')],
    [c('repo', '/h/dev/caprock-web'), c('repo', '/h/dev/work/api'), c('repo', '/h/dev/caprock')],
  ])

  it('lists a path once, under its most trusted source', () => {
    expect(all.filter((x) => x.path === '/h/dev/caprock')).toEqual([{ kind: 'project', path: '/h/dev/caprock', name: 'caprock', projectId: '1' }])
    expect(all).toHaveLength(4)
  })

  it('ranks a prefix over a substring, then a project over a repository', () => {
    const r = rankCandidates('capr', all)
    expect(r.map((x) => x.name)).toEqual(['caprock', 'caprock-web'])
    expect(r[0]!.hits).toEqual([0, 1, 2, 3])
    expect(rankCandidates('web', all)[0]!.name).toBe('caprock-web')
  })

  // Owner, 2026-11-19: with nothing typed, kit, ktl and MVP led the list
  // because they were the shortest names, not the projects in use.
  it('lists the projects last worked in first when nothing is typed', () => {
    const list = mergeCandidates([
      [{ ...c('project', '/h/dev/kit'), projectId: 'k', at: 100 }, { ...c('project', '/h/dev/caprock-web'), projectId: 'w', at: 900 }, { ...c('project', '/h/dev/caprock'), projectId: 'c' }],
      // A session in caprock is newer than the project's own figure.
      [{ ...c('recent', '/h/dev/caprock'), at: 1000 }],
    ])
    expect(list.find((x) => x.name === 'caprock')).toMatchObject({ kind: 'project', at: 1000 })
    expect(rankCandidates('', list).map((x) => x.name)).toEqual(['caprock', 'caprock-web', 'kit'])
  })

  it('takes the letters in order, and the path', () => {
    expect(rankCandidates('cpw', all).map((x) => x.name)).toEqual(['caprock-web'])
    expect(rankCandidates('work', all).map((x) => x.name)).toEqual(['api'])
    expect(matchName('caprock web', 'caprock-web')?.score).toBe(100)
  })

  it('suggests the nearest name for a mistyped one', () => {
    expect(rankCandidates('caprock-website', all)).toEqual([])
    expect(closest('caprock-website', all).map((x) => x.name)[0]).toBe('caprock-web')
    expect(closest('zz', all)).toEqual([])
  })

  it('reads the query from a typed path', () => {
    expect(queryOf('~/dev/caprock-website')).toBe('caprock-website')
    expect(queryOf('~/dev/')).toBe('')
    expect(queryOf('~')).toBe('')
    expect(queryOf('capr')).toBe('capr')
  })

  it('writes home as ~', () => {
    expect(tildePath('/h/dev/x', '/h')).toBe('~/dev/x')
    expect(tildePath('/other/x', '/h')).toBe('/other/x')
  })
})
