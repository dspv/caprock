/**
 * The right panel's Release section (owner, 2026-11-18, translated: "the
 * folded version lacks the release status, and the status when unfolded is
 * unclear"): folded, one line of where the release is, drawn at once from
 * the answers kept for the repository; unfolded, one stages strip on top.
 */
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetDeckAnswers, writeDeck } from '@/lib/deckCache'
import { FoldCtx } from './Cockpit'
import { CockpitRelease, workRepoKey } from './ReleasePlan'

const now = Date.now()
const SPEND = { cost_usd: 0, sessions: 0, live: 0, agents: [] }
const FLOW = { counts: {}, days: 14, merged: 1, ttm_count: 0, release_lag_count: 0, cost_usd: 0 }
const ROOT = '/w/app'
const stats = (prs: object[], cards: object[], releases: object[]) => ({
  connected: true, repo: 'acme/app', fetched_at: now, read_at: now, prs,
  board: { cards, releases, flow: FLOW, ships_by: 'release' },
})
const pr = (n: number, title: string, state: string, merged?: number) => ({ number: n, url: `https://github.com/acme/app/pull/${n}`, title, state, created_at: now - 7_200_000, merged_at: merged })
const rel = (tag: string, ago: number, assets: number) => ({ tag, published_at: now - ago, assets, prs: [], cost_usd: 0, sessions: 0 })
const repo = (tag: string, entries: number) => ({
  root: ROOT, name: 'app', remote: 'acme/app', via_session: 's1', live: 1,
  tags: { last: { name: tag, at: now - 3_600_000 }, gaps: 0 },
  unreleased: { ref: 'origin/master', items: [], count: entries, kinds: entries ? { Added: 2, Fixed: entries - 2 } : {} },
})

// Two entries the open batch pull request's branch carries, none merged yet.
const onBatch = {
  ref: 'origin/master', items: ['a', 'b'], count: 2, kinds: { Changed: 1, Fixed: 1 }, via: { number: 949, head: 'feat/batch', sha: 'abc' },
  entries: [
    { text: 'PR from another repo no longer shows as this one’s', scope: 'ui', kind: 'Fixed', source: 'pr' as const },
    { text: 'Folded CI second line under the word CI', scope: 'ui', kind: 'Changed', source: 'pr' as const },
  ],
}

const asked: string[] = []
beforeEach(() => {
  asked.length = 0
  // Nothing answers: what is drawn is what was kept.
  vi.stubGlobal('fetch', vi.fn((url: string) => { asked.push(url); return new Promise<Response>(() => {}) }))
})
afterEach(() => { forgetDeckAnswers(); localStorage.clear(); vi.unstubAllGlobals() })

const draw = (folded: boolean) => render(
  <FoldCtx.Provider value={{ full: !folded, toggle: () => {} }}>
    <CockpitRelease sessionId="s1" repoRoot={ROOT} />
  </FoldCtx.Provider>,
)
const line = () => document.querySelector('[data-release-fold]')

describe('the cockpit’s Release section', () => {
  it('folded, says the version, the changes waiting and the next step from the kept answers, without the Work read', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(941, 'feat: the batch', 'open'), pr(940, 'feat: a batch', 'merged', now - 1_800_000)],
      [{ number: 941, stage: 'ready', ci: 'pass', spend: SPEND }, { number: 940, stage: 'merged', spend: SPEND }], [rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), repo('v0.182.4', 5))
    draw(true)
    expect(line()).toHaveAttribute('data-release-fold', 'waiting')
    expect(line()).toHaveAttribute('aria-label', '0.183.0 · 5 changes · next: merge #941')
    // The kept entry is fresh: the Work answer is not read folded.
    expect(asked.some((u) => u.startsWith('/v1/work'))).toBe(false)
  })

  it('folded, reads the Work answer itself only when no entry is kept', () => {
    writeDeck(`stats:${ROOT}`, stats([], [], [rel('v0.182.4', 86_400_000, 23)]))
    draw(true)
    expect(asked).toContain('/v1/work')
    expect(line()).toHaveAttribute('aria-label', 'Nothing new since v0.182.4')
  })

  it('folded, says a release PR’s CI', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(942, 'chore(release): 0.183.0', 'open')], [{ number: 942, stage: 'open', ci: 'running', spend: SPEND }], [rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), repo('v0.182.4', 5))
    draw(true)
    expect(line()).toHaveAttribute('aria-label', '0.183.0 · release PR #942 · CI running')
  })

  it('folded, says a tag building with the files its release has, from the kept release run', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(942, 'chore(release): 0.183.0', 'merged', now - 900_000)], [{ number: 942, stage: 'merged', spend: SPEND }],
      [rel('v0.183.0', 120_000, 12), rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), { ...repo('v0.183.0', 0), tags: { last: { name: 'v0.183.0', at: now - 600_000 }, gaps: 0 } })
    writeDeck(`release:${ROOT}`, { connected: true, repo: 'acme/app', release: { repo: 'acme/app', tag: 'v0.183.0', state: 'running', at: now, run: { id: 1, name: 'release', status: 'in_progress', jobs: [] } } })
    draw(true)
    expect(line()).toHaveAttribute('aria-label', '0.183.0 · building · 12 of 23 files')
    // Under way, the run is asked again (the daemon answers from its kept read).
    expect(asked).toContain('/v1/sessions/s1/ci/release')
  })

  it('unfolded, draws one stages strip on top, the current stage marked', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(942, 'chore(release): 0.183.0', 'open'), pr(940, 'feat: a batch', 'merged', now - 1_800_000)],
      [{ number: 942, stage: 'open', ci: 'running', spend: SPEND }, { number: 940, stage: 'merged', spend: SPEND }], [rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), repo('v0.182.4', 5))
    draw(false)
    const strip = document.querySelector('[data-release-strip]')!
    expect(strip).not.toBeNull()
    expect([...strip.querySelectorAll('[data-strip-stage]')].map((e) => e.textContent)).toEqual(['Merged', '◉Release PR', 'Tagged', 'Building', 'Published'])
    expect(strip).toHaveAttribute('data-release-current', 'pr')
    expect(strip.querySelector('[aria-current="step"]')).toHaveTextContent('◉Release PR')
    // The strip is first; the work going into the version follows it.
    const plan = document.querySelector('[data-release-plan]')!
    expect(plan.firstElementChild).toBe(strip)
    expect(plan.querySelector('[data-release-stages]')).toBeNull()
  })

  // Coordinator, 2026-11-19: with every entry on the open batch PR the strip
  // waits at Merged, as the folded line says to merge it.
  it('with every entry on a green batch PR: next: merge, and the strip at Merged', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(949, 'fix: the batch', 'open')], [{ number: 949, stage: 'ready', ci: 'pass', spend: SPEND }], [rel('v0.183.0', 8 * 3_600_000, 23)]))
    writeDeck(workRepoKey(ROOT), { ...repo('v0.183.0', 0), unreleased: onBatch })
    const { unmount } = draw(true)
    expect(line()).toHaveAttribute('aria-label', '0.183.1 · 2 changes · next: merge #949')
    unmount()
    draw(false)
    const strip = document.querySelector('[data-release-strip]')!
    expect(strip).toHaveAttribute('data-release-current', 'merged')
    expect([...strip.querySelectorAll('[data-strip-stage]')].map((e) => e.textContent)).toEqual(['◉Merged', 'Release PR', 'Tagged', 'Building', 'Published'])
    expect(document.querySelector('[data-release-via]')).toHaveTextContent('via#949●green·ready to merge')
  })

  it('folded, says the batch PR’s red CI; unfolded, its via line names the failing check', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(949, 'fix: the batch', 'open')],
      [{ number: 949, stage: 'fix', ci: 'fail', why: 'ci', failed: ['go (windows-latest)'], spend: SPEND }], [rel('v0.183.0', 8 * 3_600_000, 23)]))
    writeDeck(workRepoKey(ROOT), { ...repo('v0.183.0', 0), unreleased: onBatch })
    const { unmount } = draw(true)
    expect(line()).toHaveAttribute('aria-label', '0.183.1 · 2 changes · batch CI red')
    expect(line()).toHaveClass('text-danger')
    unmount()
    draw(false)
    expect(document.querySelector('[data-release-head]')).toHaveTextContent(/^0\.183\.1patch: fixes only·last 1h ago$/)
    expect(document.querySelector('[data-release-via]')).toHaveTextContent('via#949●CI red·fix: go (windows-latest)')
    // Nothing is merged yet: the strip waits at Merged.
    expect(document.querySelector('[data-release-strip]')).toHaveAttribute('data-release-current', 'merged')
  })

  it('unfolded while shipping: the heading says Shipping, the strip marks the stage, the entries stay', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(950, 'chore(release): 0.183.1', 'open')], [{ number: 950, stage: 'open', ci: 'running', spend: SPEND }], [rel('v0.183.0', 8 * 3_600_000, 23)]))
    writeDeck(workRepoKey(ROOT), { ...repo('v0.183.0', 0), unreleased: { ...onBatch, entries: onBatch.entries!.map((e) => ({ ...e, source: 'master' as const })), via: undefined } })
    draw(false)
    expect(document.querySelector('[data-release-head]')).toHaveTextContent(/^Shipping 0\.183\.1/)
    expect(document.querySelector('[data-release-strip]')).toHaveAttribute('data-release-current', 'pr')
    expect([...document.querySelectorAll('[data-release-kind] h5')].map((e) => e.textContent)).toEqual(['Changed', 'Fixed'])
    expect(document.querySelector('[data-release-via]')).toBeNull()
  })

  it('unfolded within the hour of a release: out, with that release’s own notes', () => {
    writeDeck(`stats:${ROOT}`, stats([], [], [rel('v0.183.1', 300_000, 23), rel('v0.183.0', 8 * 3_600_000, 23)]))
    writeDeck(workRepoKey(ROOT), { ...repo('v0.183.1', 0), tags: { last: { name: 'v0.183.1', at: now - 600_000 }, gaps: 0 },
      released: { version: '0.183.1', count: 1, entries: [{ text: 'PR from another repo no longer shows as this one’s', scope: 'ui', kind: 'Fixed' }] } })
    draw(false)
    expect(document.querySelector('[data-release-head]')).toHaveTextContent('v0.183.1 out·5 min ago')
    expect(document.querySelector('[data-release-entries]')).toHaveTextContent('FixedPR from another repo no longer shows as this one’s')
    expect(document.querySelector('[data-release-strip]')).toHaveAttribute('data-release-current', 'published')
  })
})
