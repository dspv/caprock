import { describe, expect, it } from 'vitest'
import { foldRows, groupProjects } from './projectGroups'

const r = (project: string, cost_usd: number) => ({ project, tokens: 10, cost_usd })

describe('groupProjects', () => {
  it('folds throwaway agent folders, chats and bare folders', () => {
    const g = groupProjects([
      r('ops-agents', 4207), r('caprock', 2304), r('/', 56.6), r('src', 1.39), r('content', 1.65),
      r('ops-seo-boe0i4bn/caprock-web', 2.14), r('ops-seo-1kzbqys2/caprock-web', 2.05),
      r('ops-seo-site-m143z5ko', 1.3), r('ops-seo-site-26bjqpxs', 1.23),
      r('chat · Oct 22, 18:58', 0.23), r('chat · Oct 19, 09:40', 0.2),
    ])
    expect(g.map((x) => x.label)).toEqual(['ops-agents', 'caprock', 'other folders', 'ops-seo-*/caprock-web', 'ops-seo-site-*', 'chats'])
    const other = g.find((x) => x.label === 'other folders')!
    expect(other.members).toEqual(['/', 'src', 'content'])
    expect(other.cost_usd).toBeCloseTo(59.64)
    expect(g.find((x) => x.label === 'ops-seo-*/caprock-web')!.tokens).toBe(20)
  })

  it('keeps a real name that only looks like a stem', () => {
    const g = groupProjects([r('bloq-blockmaze', 139), r('zen-onboard-1', 8), r('app-frontend', 2), r('my-tool-ab12cd34', 1)])
    expect(g.map((x) => x.label)).toEqual(['bloq-blockmaze', 'zen-onboard-1', 'app-frontend', 'my-tool-ab12cd34'])
  })
})

describe('foldRows', () => {
  it('shows eight and folds the rest, but never folds one or two', () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => i)
    expect(foldRows(n(10), false).hidden).toHaveLength(0)
    expect(foldRows(n(11), false)).toEqual({ shown: n(8), hidden: [8, 9, 10] })
    expect(foldRows(n(11), true).hidden).toHaveLength(0)
  })
})
