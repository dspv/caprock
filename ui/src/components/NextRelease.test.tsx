import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SessionCIStats } from '@/lib/api'
import { buildWork } from '@/lib/work'
import { NOW, statsFixture, workFixture } from '@/lib/work.fixture'
import { NextRelease, releaseRepos } from './NextRelease'

const stats = new Map<string, SessionCIStats | undefined>([['/w/caprock', statsFixture()]])
const items = buildWork(workFixture(), stats, NOW).items

describe('the Next release strip', () => {
  it('speaks of the repositories with a tag, merged work or unreleased notes', () => {
    expect(releaseRepos(workFixture().repos, items).map((r) => r.name)).toEqual(['caprock'])
  })

  it('says the cadence, never a clock time for the next release', () => {
    render(<NextRelease repos={workFixture().repos} stats={stats} items={items} now={NOW} />)
    const strip = document.querySelector('[data-work-release-repo="caprock"]') as HTMLElement
    expect(strip).toHaveTextContent('2h 05m since v0.117.4 · usual gap 2h 40m (median of 9)')
    expect(strip).toHaveTextContent('6 commits since the tag')
    expect(strip).toHaveTextContent('Merged, waiting for a release')
    expect(strip).not.toHaveTextContent(/\d{1,2}:\d{2}/)
  })

  it('says when GitHub is not connected', () => {
    const off = new Map<string, SessionCIStats | undefined>([['/w/caprock', { connected: false, prs: [] }]])
    const w = workFixture()
    render(<NextRelease repos={w.repos} stats={off} items={buildWork(w, off, NOW).items} now={NOW} />)
    expect(document.querySelector('[data-work-repo-notes]')).toHaveTextContent('caprock: GitHub is not connected')
  })

  it('draws nothing with nothing to say', () => {
    const { container } = render(<NextRelease repos={[{ root: '/w/a', name: 'a', remote: 'x/a', via_session: 's', live: 1 }]} stats={new Map()} items={[]} now={NOW} />)
    expect(container).toBeEmptyDOMElement()
  })
})
