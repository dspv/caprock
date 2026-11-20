/**
 * The right panel's Release section (owner, 2026-11-18, translated: "the
 * folded version lacks the release status, and the status when unfolded is
 * unclear"): folded, one line of where the release is, drawn at once from
 * the answers kept for the repository; unfolded, the version, then the
 * stages as dots with only the current one named (variant A, 2026-11-19).
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
  // Owner, 2026-11-20, translated: "I stopped understanding what this means
  // … I must know the status exactly": merged, no release PR, nothing runs.
  it('folded, says the release is ready and not started, grey, from the kept answers, without the Work read', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(941, 'feat: the batch', 'open'), pr(940, 'feat: a batch', 'merged', now - 1_800_000)],
      [{ number: 941, stage: 'ready', ci: 'pass', spend: SPEND }, { number: 940, stage: 'merged', spend: SPEND }], [rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), repo('v0.182.4', 5))
    draw(true)
    expect(line()).toHaveAttribute('data-release-fold', 'ready')
    expect(line()).toHaveAttribute('aria-label', 'Ready to release 0.183.0 · not started · 5 changes · PR #941 green')
    expect(line()).toHaveClass('text-fg-muted')
    expect(line()!.querySelector('[data-release-fold-pulse]')).toBeNull()
    // The kept entry is fresh: the Work answer is not read folded.
    expect(asked.some((u) => u.startsWith('/v1/work'))).toBe(false)
  })

  it('folded, reads the Work answer itself only when no entry is kept', () => {
    writeDeck(`stats:${ROOT}`, stats([], [], [rel('v0.182.4', 86_400_000, 23)]))
    draw(true)
    expect(asked).toContain('/v1/work')
    expect(line()).toHaveAttribute('aria-label', 'Nothing new since v0.182.4')
  })

  it('folded, says a release PR whose checks run as releasing, blue and pulsing', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(942, 'chore(release): 0.183.0', 'open')], [{ number: 942, stage: 'open', ci: 'running', spend: SPEND }], [rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), repo('v0.182.4', 5))
    draw(true)
    expect(line()).toHaveAttribute('aria-label', 'Releasing 0.183.0 · checks running')
    expect(line()).toHaveClass('text-progress')
    expect(line()!.querySelector('[data-release-fold-pulse]')).toHaveClass('release-step-pulse')
  })

  it('folded, says a tag building with the files its release has, from the kept release run', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(942, 'chore(release): 0.183.0', 'merged', now - 900_000)], [{ number: 942, stage: 'merged', spend: SPEND }],
      [rel('v0.183.0', 120_000, 12), rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), { ...repo('v0.183.0', 0), tags: { last: { name: 'v0.183.0', at: now - 600_000 }, gaps: 0 } })
    writeDeck(`release:${ROOT}`, { connected: true, repo: 'acme/app', release: { repo: 'acme/app', tag: 'v0.183.0', state: 'running', at: now, run: { id: 1, name: 'release', status: 'in_progress', jobs: [] } } })
    draw(true)
    expect(line()).toHaveAttribute('aria-label', 'Releasing 0.183.0 · building apps, 12 of 23 files')
    // Under way, the run is asked again (the daemon answers from its kept read).
    expect(asked).toContain('/v1/sessions/s1/ci/release')
  })

  // Owner, 2026-11-19, variant A (translated: "dots, one word — looks more
  // logical"): the word strip wrapped at 330px.
  it('unfolded, the version first, then five dots with only the current stage named', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(942, 'chore(release): 0.183.0', 'open'), pr(940, 'feat: a batch', 'merged', now - 1_800_000)],
      [{ number: 942, stage: 'open', ci: 'running', spend: SPEND, os: [{ os: 'linux', state: 'pass', checks: 4 }, { os: 'macos', state: 'running', checks: 4 }, { os: 'windows', state: 'running', checks: 4 }] },
        { number: 940, stage: 'merged', spend: SPEND }], [rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), repo('v0.182.4', 5))
    draw(false)
    const strip = document.querySelector('[data-release-strip]')!
    expect(strip).toHaveAttribute('data-release-current', 'pr')
    expect(strip).toHaveAttribute('role', 'group')
    expect(strip).toHaveAttribute('aria-label', 'Release stage 2 of 5: Release PR, in progress')
    expect(strip).toHaveAttribute('data-release-tone', 'active')
    const dots = [...strip.querySelectorAll('[data-strip-stage]')]
    expect(dots.map((e) => e.getAttribute('data-strip-stage'))).toEqual(['merged', 'pr', 'tag', 'builds', 'published'])
    expect(dots.map((e) => e.getAttribute('data-step-state'))).toEqual(['done', 'current', 'todo', 'todo', 'todo'])
    expect(dots.map((e) => e.textContent)).toEqual(['', '', '', '', ''])
    // Each dot says its stage and its state in words on hover.
    expect(dots.map((e) => e.getAttribute('title')!.split('\n')[0])).toEqual(['Merged: done', 'Release PR: in progress', 'Tagged: not started', 'Building: not started', 'Published: not started'])
    expect(dots[0]).toHaveClass('bg-ok')
    // In progress right now: blue and pulsing, never the amber of waiting.
    expect(dots[1]).toHaveClass('bg-progress', 'release-step-pulse')
    expect(dots[1]).not.toHaveClass('bg-warn')
    expect([...strip.querySelectorAll('[data-strip-line]')].map((e) => e.getAttribute('data-strip-line'))).toEqual(['done', 'todo', 'todo', 'todo'])
    // Only the current stage is named, with its checks per OS.
    expect(strip.querySelector('[data-release-stage-words]')).toHaveTextContent(/^Releasing · checks 1 of 3 systems$/)
    expect(strip.querySelector('[data-release-stage-words]')).toHaveClass('text-progress')
    expect(strip.textContent).not.toMatch(/Tagged|Building|Published/)
    // The version heads the section; the dots sit under it, the entries apart.
    const plan = document.querySelector('[data-release-plan]')!
    const head = plan.querySelector('[data-release-group="head"]')!
    expect(plan.firstElementChild).toBe(head)
    expect(head.firstElementChild).toHaveAttribute('data-release-head')
    expect(head.lastElementChild).toBe(strip)
    expect(plan.querySelector('[data-release-stages]')).toBeNull()
  })

  it('draws a failed stage red, the dot and the words', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(942, 'chore(release): 0.183.0', 'open')], [{ number: 942, stage: 'fix', ci: 'fail', why: 'ci', spend: SPEND }], [rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), repo('v0.182.4', 5))
    draw(false)
    const strip = document.querySelector('[data-release-strip]')!
    expect(strip).toHaveAttribute('data-release-tone', 'fail')
    expect(strip.querySelector('[data-strip-stage="pr"]')).toHaveClass('bg-danger')
    const words = strip.querySelector('[data-release-stage-words]')!
    expect(words).toHaveTextContent('Release stopped · checks failed')
    expect(words).toHaveClass('text-danger')
  })

  // Coordinator, 2026-11-19: with every entry on the open batch PR the strip
  // waits at Merged, as the folded line says to merge it.
  it('with every entry on a green batch PR: waiting for it to merge, amber, the strip at Merged', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(949, 'fix: the batch', 'open')], [{ number: 949, stage: 'ready', ci: 'pass', spend: SPEND }], [rel('v0.183.0', 8 * 3_600_000, 23)]))
    writeDeck(workRepoKey(ROOT), { ...repo('v0.183.0', 0), unreleased: onBatch })
    const { unmount } = draw(true)
    expect(line()).toHaveAttribute('aria-label', 'Waiting for #949 to merge · 0.183.1 · 2 changes')
    expect(line()).toHaveClass('text-warn')
    unmount()
    draw(false)
    const strip = document.querySelector('[data-release-strip]')!
    expect(strip).toHaveAttribute('data-release-current', 'merged')
    expect(strip).toHaveAttribute('aria-label', 'Release stage 1 of 5: Merged, waiting')
    expect(strip.querySelector('[data-release-stage-words]')).toHaveTextContent(/^Waiting for #949 to merge$/)
    expect(strip.querySelector('[data-strip-stage="merged"]')).toHaveClass('bg-warn')
    // The batch's checks and state: one via line, the first of the bottom group, never twice.
    const via = document.querySelectorAll('[data-release-via]')
    expect(via).toHaveLength(1)
    expect(via[0]).toHaveTextContent('via#949●green·ready to merge')
    expect(via[0]!.parentElement).toHaveAttribute('data-release-group', 'later')
    expect(via[0]!.parentElement!.firstElementChild).toBe(via[0])
    // The words name the batch once more: it is what the release waits for.
    expect(document.querySelector('[data-release-plan]')!.textContent!.match(/#949/g)).toHaveLength(2)
    // Three groups apart: the head, the entries and the bottom lines, each after a hairline.
    const groups = [...document.querySelector('[data-release-plan]')!.children]
    expect(groups.map((g) => g.getAttribute('data-release-group'))).toEqual(['head', 'entries', 'later'])
    expect(groups.map((g) => g.classList.contains('border-t'))).toEqual([false, true, true])
  })

  it('folded, says the batch PR’s checks failed, red; unfolded, its via line names the failing check', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(949, 'fix: the batch', 'open')],
      [{ number: 949, stage: 'fix', ci: 'fail', why: 'ci', failed: ['go (windows-latest)'], spend: SPEND }], [rel('v0.183.0', 8 * 3_600_000, 23)]))
    writeDeck(workRepoKey(ROOT), { ...repo('v0.183.0', 0), unreleased: onBatch })
    const { unmount } = draw(true)
    expect(line()).toHaveAttribute('aria-label', 'Waiting for #949 to merge · its checks failed · 0.183.1 · 2 changes')
    expect(line()).toHaveClass('text-danger')
    unmount()
    draw(false)
    // The heading names what the number is (owner, 2026-11-20).
    expect(document.querySelector('[data-release-head]')).toHaveTextContent(/^Next release 0\.183\.1·patch·last release 1h ago$/)
    expect(document.querySelector('[data-release-via]')).toHaveTextContent('via#949●CI red·fix: go (windows-latest)')
    // Nothing is merged yet: the strip waits at Merged.
    expect(document.querySelector('[data-release-strip]')).toHaveAttribute('data-release-current', 'merged')
  })

  it('unfolded while shipping: the heading says Releasing, the strip marks the stage, the entries stay', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(950, 'chore(release): 0.183.1', 'open')], [{ number: 950, stage: 'open', ci: 'running', spend: SPEND }], [rel('v0.183.0', 8 * 3_600_000, 23)]))
    writeDeck(workRepoKey(ROOT), { ...repo('v0.183.0', 0), unreleased: { ...onBatch, entries: onBatch.entries!.map((e) => ({ ...e, source: 'master' as const })), via: undefined } })
    draw(false)
    expect(document.querySelector('[data-release-head]')).toHaveTextContent(/^Releasing 0\.183\.1/)
    expect(document.querySelector('[data-release-strip]')).toHaveAttribute('data-release-current', 'pr')
    expect([...document.querySelectorAll('[data-release-kind] h5')].map((e) => e.textContent)).toEqual(['Changed', 'Fixed'])
    expect(document.querySelector('[data-release-via]')).toBeNull()
  })

  it('unfolded within the hour of a release: released, green, with that release’s own notes', () => {
    writeDeck(`stats:${ROOT}`, stats([], [], [rel('v0.183.1', 300_000, 23), rel('v0.183.0', 8 * 3_600_000, 23)]))
    writeDeck(workRepoKey(ROOT), { ...repo('v0.183.1', 0), tags: { last: { name: 'v0.183.1', at: now - 600_000 }, gaps: 0 },
      released: { version: '0.183.1', count: 1, entries: [{ text: 'PR from another repo no longer shows as this one’s', scope: 'ui', kind: 'Fixed' }] } })
    draw(false)
    expect(document.querySelector('[data-release-head]')).toHaveTextContent('0.183.1 released·5 min ago')
    expect(document.querySelector('[data-release-entries]')).toHaveTextContent('Fixed1▸•PR from another repo no longer shows as this one’s')
    expect(document.querySelector('[data-release-strip]')).toHaveAttribute('data-release-current', 'published')
    expect(document.querySelector('[data-release-stage-words]')).toHaveTextContent(/^Released · 5 min ago$/)
    expect(document.querySelector('[data-release-stage-words]')).toHaveClass('text-ok')
    expect([...document.querySelectorAll('[data-strip-stage]')].map((e) => e.getAttribute('data-step-state'))).toEqual(['done', 'done', 'done', 'done', 'current'])
  })

  it('unfolded while a tag builds: four dots on, Building named with its files', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(942, 'chore(release): 0.183.0', 'merged', now - 900_000)], [{ number: 942, stage: 'merged', spend: SPEND }],
      [rel('v0.183.0', 120_000, 12), rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), { ...repo('v0.183.0', 0), tags: { last: { name: 'v0.183.0', at: now - 600_000 }, gaps: 0 } })
    writeDeck(`release:${ROOT}`, { connected: true, repo: 'acme/app', release: { repo: 'acme/app', tag: 'v0.183.0', state: 'running', at: now, run: { id: 1, name: 'release', status: 'in_progress', jobs: [] } } })
    draw(false)
    const strip = document.querySelector('[data-release-strip]')!
    expect(strip).toHaveAttribute('aria-label', 'Release stage 4 of 5: Building, in progress')
    expect(strip.querySelector('[data-release-stage-words]')).toHaveTextContent(/^Releasing · building apps, 12 of 23 files$/)
    expect([...strip.querySelectorAll('[data-strip-stage]')].map((e) => e.getAttribute('data-step-state'))).toEqual(['done', 'done', 'done', 'current', 'done'])
  })

  // The owner's screenshot, 2026-11-20: *0.185.1 patch · last 2h ago* over an
  // amber *Release PR · not opened yet* read as a release under way.
  it('unfolded, merged with no release PR: Next release named, the dot hollow grey, Ready to release · not started', () => {
    writeDeck(`stats:${ROOT}`, stats([], [], [rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), repo('v0.182.4', 5))
    draw(false)
    expect(document.querySelector('[data-release-head]')).toHaveTextContent(/^Next release 0\.183\.0·minor·last release 1h ago$/)
    // The age's "release" goes below 350px of panel, the version's below 290px: one line at any width.
    expect([...document.querySelectorAll('[data-head-wide]')].map((e) => e.className)).toEqual(['hidden @[290px]/head:inline', 'hidden @[350px]/head:inline'])
    const strip = document.querySelector('[data-release-strip]')!
    expect(strip).toHaveAttribute('data-release-tone', 'idle')
    expect(strip).toHaveAttribute('aria-label', 'Release stage 2 of 5: Release PR, not started')
    const dot = strip.querySelector('[data-strip-stage="pr"]')!
    expect(dot).toHaveClass('bg-transparent', 'border-fg-muted')
    expect(dot).not.toHaveClass('release-step-pulse')
    expect(dot).not.toHaveClass('bg-warn')
    expect(dot.getAttribute('title')).toMatch(/^Release PR: not started\nNothing is running\./)
    const words = strip.querySelector('[data-release-stage-words]')!
    expect(words).toHaveTextContent(/^Ready to release · not started$/)
    expect(words).toHaveClass('text-fg-muted')
  })

  it('unfolded with nothing new: the line stays, no dots', () => {
    writeDeck(`stats:${ROOT}`, stats([], [], [rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), repo('v0.182.4', 0))
    draw(false)
    expect(document.querySelector('[data-release-head]')).toHaveTextContent(/^Nothing new since v0\.182\.4/)
    expect(document.querySelector('[data-release-strip]')).toBeNull()
    expect(document.querySelector('[data-strip-stage]')).toBeNull()
  })
})
