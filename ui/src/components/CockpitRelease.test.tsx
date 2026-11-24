/**
 * The right panel's Release section (owner, 2026-11-18, translated: "the
 * folded version lacks the release status, and the status when unfolded is
 * unclear"): folded, one line of where the release is, drawn at once from
 * the answers kept for the repository; unfolded, the version, then the
 * stages as dots with only the current one named (variant A, 2026-11-19).
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetDeckAnswers, markReading, writeDeck } from '@/lib/deckCache'
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
  // Owner, 2026-11-20, translated: "I open it, see red, click around and it
  // fixes itself". The CI words drawn from a kept Pipeline answer being
  // read again are faint, as of its age; full strength once it lands.
  it('draws its CI words from a kept copy being read again faint, as of its age', () => {
    const old = { ...stats([pr(949, 'fix: the batch', 'open')], [{ number: 949, stage: 'fix', ci: 'fail', why: 'ci', failed: ['e2e (headless shell)'], spend: SPEND }], [rel('v0.183.0', 8 * 3_600_000, 23)]),
      fetched_at: now - 25 * 60_000, read_at: now - 25 * 60_000 }
    writeDeck(`stats:${ROOT}`, old, now - 25 * 60_000)
    writeDeck(workRepoKey(ROOT), { ...repo('v0.183.0', 0), unreleased: onBatch })
    markReading(`stats:${ROOT}`, true)
    const { unmount } = draw(false)
    const strip = () => document.querySelector('[data-release-strip]')!
    expect(strip()).toHaveAttribute('data-release-kept')
    expect(strip()).toHaveClass('opacity-70', 'saturate-50')
    expect(document.querySelector('[data-release-kept-age]')).toHaveTextContent(/^as of 25 min ago$/)
    act(() => { markReading(`stats:${ROOT}`, false) })
    expect(strip()).not.toHaveAttribute('data-release-kept')
    expect(document.querySelector('[data-release-kept-age]')).toBeNull()
    unmount()
    markReading(`stats:${ROOT}`, true)
    draw(true)
    expect(line()).toHaveAttribute('data-release-kept')
    expect(line()).toHaveClass('opacity-70')
    expect(line()!.getAttribute('title')).toMatch(/as of 25 min ago, being read again$/)
  })

  // Owner, 2026-11-20, translated: "I stopped understanding what this means
  // … I must know the status exactly": merged, no release PR, nothing runs.
  it('folded, says the release is ready and not started, grey, from the kept answers, without the Work read', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(941, 'feat: 0.183.0 batch — two things', 'open'), pr(940, 'feat: a batch', 'merged', now - 1_800_000)],
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

  // Owner, 2026-11-24, variant A: just out, the version is a green pill and
  // the release's agent cost stands beside its age, in the line's own words.
  it('folded within the hour of a release: a green pill, its age, and its agent cost', () => {
    const out = { ...rel('v0.183.0', 4 * 60_000, 23), cost_usd: 17.25, prs: [942, 940, 939], sessions: 2 }
    writeDeck(`stats:${ROOT}`, stats([pr(942, 'chore(release): 0.183.0', 'merged', now - 600_000)], [{ number: 942, stage: 'released', spend: SPEND }], [out, rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), repo('v0.183.0', 0))
    draw(true)
    expect(line()).toHaveAttribute('data-release-fold', 'out')
    expect(line()).toHaveAttribute('aria-label', '0.183.0 released · 4 min ago · $17.25')
    const pill = line()!.querySelector('[data-release-pill]')!
    expect(pill).toHaveTextContent(/^0\.183\.0 released$/)
    expect(pill).toHaveClass('rounded-full', 'text-ok', 'font-semibold')
    const cost = line()!.querySelector('[data-release-fold-cost]')!
    expect(cost).toHaveTextContent(/^·\s?\$17\.25$/)
    expect(cost.getAttribute('title')).toMatch(/^\$17\.25 agents spent on 3 pull requests, 2 sessions/)
    // Not on view in a test's DOM: no burst, and the tag is not taken as seen.
    expect(document.querySelector('[data-release-burst]')).toBeNull()
    expect(localStorage.getItem('caprock.release-burst')).toBeNull()
  })

  it('folded within the hour of a release with no recorded cost: no figure, never $0', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(942, 'chore(release): 0.183.0', 'merged', now - 600_000)], [{ number: 942, stage: 'released', spend: SPEND }], [rel('v0.183.0', 4 * 60_000, 23), rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), repo('v0.183.0', 0))
    draw(true)
    expect(line()).toHaveAttribute('aria-label', '0.183.0 released · 4 min ago')
    expect(line()!.querySelector('[data-release-fold-cost]')).toBeNull()
  })

  // Owner, 2026-11-23: an ordinary open feature PR (#1030) was drawn as the
  // release's *via #1030 · green · ready to merge* while master held fixes
  // only. It is not the batch: no via line, no *PR #* in the folded line,
  // and it stays under Not in it yet.
  it('never takes an ordinary open feature PR for the batch', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(1030, 'feat(app): offline dictation on Windows and Linux', 'open'), pr(1031, 'fix(cursor): no zero cost', 'merged', now - 1_800_000)],
      [{ number: 1030, stage: 'ready', ci: 'pass', spend: SPEND }, { number: 1031, stage: 'merged', spend: SPEND }], [rel('v0.190.0', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), { ...repo('v0.190.0', 1), unreleased: { ref: 'origin/master', items: ['a'], count: 1, kinds: { Fixed: 1 } } })
    const { unmount } = draw(true)
    expect(line()).toHaveAttribute('aria-label', 'Ready to release 0.190.1 · not started · 1 change')
    unmount()
    draw(false)
    expect(document.querySelector('[data-release-via]')).toBeNull()
    expect(document.querySelector('[data-release-section="branch"]')).toHaveTextContent('Not in it yet: 1 other PR')
    // What it would make the version, from its title (variant 1A).
    expect(document.querySelector('[data-release-hint]')).toHaveAttribute('data-release-hint', '0.191.0')
  })

  // Owner, 2026-11-23: after #1031 merged the panel said *Ready to release ·
  // not started* while master's checks ran. From the default branch's CI
  // the Pipeline keeps, it says them; it never claims a release is queued.
  it('says master’s checks running in place of not started', () => {
    writeDeck(`stats:${ROOT}`, { ...stats([pr(1031, 'fix(cursor): no zero cost', 'merged', now - 600_000)],
      [{ number: 1031, stage: 'merged', spend: SPEND }], [rel('v0.190.0', 86_400_000, 23)]), board: { cards: [{ number: 1031, stage: 'merged', spend: SPEND }], releases: [rel('v0.190.0', 86_400_000, 23)], flow: FLOW, ships_by: 'release', default_branch: 'master' } })
    writeDeck(workRepoKey(ROOT), { ...repo('v0.190.0', 1), unreleased: { ref: 'origin/master', items: ['a'], count: 1, kinds: { Fixed: 1 } } })
    const job = (id: number, status: string, conclusion?: string) => ({ id, run_id: 1, name: `job ${id}`, status, conclusion, labels: [], steps: [] })
    const jobs = [...Array.from({ length: 12 }, (_, i) => job(i, 'completed', 'success')), ...Array.from({ length: 5 }, (_, i) => job(20 + i, 'in_progress'))]
    const main = (state: string, js: object[]) => ({ connected: true, repo: 'acme/app', branch: 'master', ci: { repo: 'acme/app', head_sha: 'a1f2189d', branch: 'master', state, runs: [{ id: 1, name: 'ci', status: 'in_progress', created_at: now - 590_000, jobs: js }], runner_ms: 0, by_os: [], at: now } })
    writeDeck(`main:${ROOT}`, main('running', jobs))
    const { unmount } = draw(true)
    expect(line()).toHaveAttribute('aria-label', '0.190.1 · master checks running · 12 of 17 · 1 change')
    expect(line()).toHaveClass('text-warn')
    // Within the hour of the merge, the default branch's checks are asked (the daemon keeps them).
    expect(asked).toContain('/v1/sessions/s1/ci/main')
    unmount()
    draw(false)
    const words = document.querySelector('[data-release-stage-words]')!
    expect(words).toHaveTextContent(/^master checks running · 12 of 17$/)
    expect(words.getAttribute('title')).toMatch(/Nothing read says whether a release is queued\.$/)
    forgetDeckAnswers()
  })

  it('says master’s checks failed, red', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(1031, 'fix(cursor): no zero cost', 'merged', now - 600_000)], [{ number: 1031, stage: 'merged', spend: SPEND }], [rel('v0.190.0', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), { ...repo('v0.190.0', 1), unreleased: { ref: 'origin/master', items: ['a'], count: 1, kinds: { Fixed: 1 } } })
    writeDeck(`main:${ROOT}`, { connected: true, repo: 'acme/app', branch: 'master', ci: { repo: 'acme/app', head_sha: 'a1f2189d', branch: 'master', state: 'fail', runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'failure', created_at: now - 590_000, jobs: [{ id: 1, run_id: 1, name: 'go (windows-latest)', status: 'completed', conclusion: 'failure', labels: [], steps: [] }] }], runner_ms: 0, by_os: [], at: now } })
    draw(true)
    expect(line()).toHaveAttribute('aria-label', '0.190.1 · master checks failed · 1 change')
    expect(line()).toHaveClass('text-danger')
    expect(line()!.getAttribute('title')).toMatch(/go \(windows-latest\)/)
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
    expect(line()).toHaveAttribute('aria-label', 'Releasing 0.183.0 · building 12 of 23 files')
    // Under way, the run is asked again (the daemon answers from its kept read).
    expect(asked).toContain('/v1/sessions/s1/ci/release')
  })

  // Owner, 2026-11-23, variant A: a stepper across the panel, one word under
  // each circle, the state whole on its own line below.
  it('unfolded, the version first, then a five-step list with the state under it', () => {
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
    // An ordered list: one word under each circle, each step's stage and
    // state in words on hover and for a screen reader, the current one
    // aria-current.
    const list = strip.querySelector('ol[data-release-steps]')!
    const steps = [...list.querySelectorAll(':scope > li')]
    expect(steps.map((e) => e.querySelector('[data-strip-word]')!.textContent)).toEqual(['Merged', 'PR', 'Tagged', 'Build', 'Out'])
    expect(steps.map((e) => e.querySelector('[data-strip-word]')!.textContent!.length <= 7)).toEqual([true, true, true, true, true])
    const said = ['Merged: done', 'Release PR: in progress', 'Tagged: not started', 'Building: not started', 'Published: not started']
    expect(steps.map((e) => e.getAttribute('title')!.split('\n')[0])).toEqual(said)
    expect(steps.map((e) => e.querySelector('.sr-only')!.textContent)).toEqual(said)
    expect(steps.map((e) => e.getAttribute('aria-current'))).toEqual([null, 'step', null, null, null])
    expect(dots[0]).toHaveClass('bg-ok')
    // In progress right now: blue and pulsing, never the amber of waiting.
    expect(dots[1]).toHaveClass('bg-progress', 'release-step-pulse')
    expect(dots[1]).not.toHaveClass('bg-warn')
    expect([...strip.querySelectorAll('[data-strip-line]')].map((e) => e.getAttribute('data-strip-line'))).toEqual(['done', 'todo', 'todo', 'todo'])
    // The state on its own line under the steps, with its checks per OS,
    // never cut with an ellipsis.
    const words = strip.querySelector('[data-release-stage-words]')!
    expect(words).toHaveTextContent(/^checks 1 of 3 systems$/)
    expect(words).toHaveClass('text-progress')
    expect(words).not.toHaveClass('truncate')
    expect(list.nextElementSibling).toBe(words.parentElement)
    expect(steps[1]!.querySelector('[data-strip-word]')).toHaveClass('text-progress')
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
    // The batch's number and state once, beside the dots (owner, 2026-11-20:
    // the via line said #949 again); the words open the Pipeline on it.
    const words = strip.querySelector<HTMLAnchorElement>('[data-release-stage-words]')!
    expect(words).toHaveTextContent(/^Waiting for #949 · ready to merge$/)
    expect(words.tagName).toBe('A')
    expect(words.getAttribute('href')).toContain('pr=949')
    expect(words).toHaveClass('text-warn')
    expect(strip.querySelector('[data-strip-stage="merged"]')).toHaveClass('bg-warn')
    expect(document.querySelector('[data-release-via]')).toBeNull()
    expect(document.querySelector('[data-release-plan]')!.textContent!.match(/#949/g)).toHaveLength(1)
    // Two groups apart: the head and the entries, after a hairline.
    const groups = [...document.querySelector('[data-release-plan]')!.children]
    expect(groups.map((g) => g.getAttribute('data-release-group'))).toEqual(['head', 'entries'])
    expect(groups.map((g) => g.classList.contains('border-t'))).toEqual([false, true])
  })

  it('folded, says the batch PR’s checks failed, red; unfolded, its via line names the failing check', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(949, 'fix: the batch', 'open')],
      [{ number: 949, stage: 'fix', ci: 'fail', why: 'ci', failed: ['go (windows-latest)'], spend: SPEND }], [rel('v0.183.0', 8 * 3_600_000, 23)]))
    writeDeck(workRepoKey(ROOT), { ...repo('v0.183.0', 0), unreleased: onBatch })
    const { unmount } = draw(true)
    expect(line()).toHaveAttribute('aria-label', 'Waiting for #949 to merge · CI red · 0.183.1 · 2 changes')
    expect(line()).toHaveClass('text-danger')
    unmount()
    draw(false)
    // The heading names what the number is (owner, 2026-11-20).
    expect(document.querySelector('[data-release-head]')).toHaveTextContent(/^Next release 0\.183\.1·patch · fixes only·last release 1h ago$/)
    // One line for the batch and its CI, never twice (owner, 2026-11-20:
    // the via line and the words both said #977 and CI red), the failing
    // check by name on hover rather than *fix: go (windows-latest)*.
    expect(document.querySelector('[data-release-via]')).toBeNull()
    const words = document.querySelector('[data-release-stage-words]')!
    expect(words).toHaveTextContent(/^Waiting for #949 · CI red$/)
    expect(words).toHaveClass('text-danger')
    expect(words.getAttribute('title')).toMatch(/Failed: go \(windows-latest\)\. It cannot merge until they pass\./)
    expect(document.querySelector('[data-release-plan]')!.textContent).not.toMatch(/fix: /)
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
    const head = document.querySelector('[data-release-head]')!
    expect(head).toHaveAttribute('data-release-head', 'out')
    expect(head).toHaveTextContent(/^0\.183\.1 released\s?5 min ago$/)
    expect(head.querySelector('[data-release-pill]')).toHaveTextContent(/^0\.183\.1 released$/)
    expect(document.querySelector('[data-release-entries]')).toHaveTextContent('Fixed1•PR from another repo no longer shows as this one’s')
    expect(document.querySelector('[data-release-strip]')).toHaveAttribute('data-release-current', 'published')
    // The heading says it: no *Released · 5 min ago* under the steps.
    expect(document.querySelector('[data-release-stage-words]')).toBeNull()
    expect(document.querySelector('[data-release-strip]')).not.toHaveTextContent(/released/i)
    expect([...document.querySelectorAll('[data-strip-stage]')].map((e) => e.getAttribute('data-step-state'))).toEqual(['done', 'done', 'done', 'done', 'current'])
  })

  // Owner, 2026-11-24, translated: "is it supposed to be like this? where is
  // it" — unfolded, the pill and the cost were gone and *released · 23 min
  // ago* stood twice.
  it('unfolded within the hour of a release: the folded line’s pill, age and cost as the heading, said once', () => {
    const out = { ...rel('v0.183.0', 23 * 60_000, 23), cost_usd: 17.25, prs: [942, 940, 939], sessions: 2 }
    writeDeck(`stats:${ROOT}`, stats([pr(942, 'chore(release): 0.183.0', 'merged', now - 30 * 60_000)], [{ number: 942, stage: 'released', spend: SPEND }], [out, rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), repo('v0.183.0', 0))
    draw(false)
    const head = document.querySelector('[data-release-head]')!
    expect(head).toHaveAttribute('data-release-head', 'out')
    const h3 = head.querySelector('h3')!
    expect(h3).toHaveAttribute('aria-label', '0.183.0 released · 23 min ago · $17.25')
    expect(h3).toHaveClass('text-ok', 'h-[16px]')
    const pill = head.querySelector('[data-release-pill]')!
    expect(pill).toHaveTextContent(/^0\.183\.0 released$/)
    expect(pill).toHaveClass('rounded-full', 'text-ok', 'font-semibold')
    expect(head.querySelector('[data-release-fold-age]')).toHaveTextContent(/^23 min ago$/)
    const cost = head.querySelector('[data-release-fold-cost]')!
    expect(cost).toHaveTextContent(/^·\s?\$17\.25$/)
    expect(cost.getAttribute('title')).toMatch(/^\$17\.25 agents spent on 3 pull requests, 2 sessions/)
    // Said once: the steps alone under it, *Out* green and current.
    expect(document.querySelector('[data-release-stage-words]')).toBeNull()
    expect(document.querySelectorAll('[data-release-pill]')).toHaveLength(1)
    expect(document.querySelector('[data-strip-step="published"]')).toHaveAttribute('aria-current', 'step')
    expect(document.querySelector('[data-release-strip]')).toHaveAttribute('data-release-tone', 'ok')
    // No other release text beside the heading says *released* again.
    expect(document.querySelector('[data-release-group="head"]')!.textContent!.match(/released/gi)).toHaveLength(1)
  })

  it('unfolded within the hour of a release with no recorded cost: the pill and its age, never $0', () => {
    writeDeck(`stats:${ROOT}`, stats([], [], [rel('v0.183.0', 4 * 60_000, 23), rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), repo('v0.183.0', 0))
    draw(false)
    const head = document.querySelector('[data-release-head]')!
    expect(head.querySelector('h3')).toHaveAttribute('aria-label', '0.183.0 released · 4 min ago')
    expect(head.querySelector('[data-release-pill]')).not.toBeNull()
    expect(head.querySelector('[data-release-fold-cost]')).toBeNull()
    expect(head).not.toHaveTextContent('$')
  })

  it('unfolded past the hour of a release: nothing new, no steps, nothing said twice', () => {
    writeDeck(`stats:${ROOT}`, stats([], [], [rel('v0.183.0', 3 * 3_600_000, 23)]))
    writeDeck(workRepoKey(ROOT), repo('v0.183.0', 0))
    draw(false)
    expect(document.querySelector('[data-release-head]')).toHaveAttribute('data-release-head', 'idle')
    expect(document.querySelector('[data-release-pill]')).toBeNull()
    expect(document.querySelector('[data-release-strip]')).toBeNull()
    expect(document.querySelector('[data-release-stage-words]')).toBeNull()
  })

  it('unfolded while a tag builds: four dots on, Building named with its files', () => {
    writeDeck(`stats:${ROOT}`, stats([pr(942, 'chore(release): 0.183.0', 'merged', now - 900_000)], [{ number: 942, stage: 'merged', spend: SPEND }],
      [rel('v0.183.0', 120_000, 12), rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), { ...repo('v0.183.0', 0), tags: { last: { name: 'v0.183.0', at: now - 600_000 }, gaps: 0 } })
    writeDeck(`release:${ROOT}`, { connected: true, repo: 'acme/app', release: { repo: 'acme/app', tag: 'v0.183.0', state: 'running', at: now, run: { id: 1, name: 'release', status: 'in_progress', jobs: [] } } })
    draw(false)
    const strip = document.querySelector('[data-release-strip]')!
    expect(strip).toHaveAttribute('aria-label', 'Release stage 4 of 5: Building, in progress')
    expect(strip.querySelector('[data-release-stage-words]')).toHaveTextContent(/^building 12 of 23 files$/)
    expect([...strip.querySelectorAll('[data-strip-stage]')].map((e) => e.getAttribute('data-step-state'))).toEqual(['done', 'done', 'done', 'current', 'done'])
  })

  // The owner's screenshot, 2026-11-20: *0.185.1 patch · last 2h ago* over an
  // amber *Release PR · not opened yet* read as a release under way.
  it('unfolded, merged with no release PR: Next release named, the dot hollow grey, Ready to release · not started', () => {
    writeDeck(`stats:${ROOT}`, stats([], [], [rel('v0.182.4', 86_400_000, 23)]))
    writeDeck(workRepoKey(ROOT), repo('v0.182.4', 5))
    draw(false)
    expect(document.querySelector('[data-release-head]')).toHaveTextContent(/^Next release 0\.183\.0·minor · a feature·last release 1h ago$/)
    // Words go before anything is cut (owner, 2026-11-20): the version's
    // " release" below 340px of panel; the last release's age only from
    // 400px (owner, 2026-11-23: a bare *1h ago* read as the version's age)
    // — *Next 0.183.0 · minor · a feature* in the 330px cockpit.
    const wide = [...document.querySelectorAll('[data-head-wide]')]
    expect(wide.map((e) => e.className)).toEqual(['hidden @[340px]/head:inline'])
    expect(wide.map((e) => e.textContent)).toEqual(['release '])
    expect(document.querySelector('[data-release-since-wide]')).toHaveClass('hidden', '@[400px]/head:flex')
    expect(document.querySelector('[data-release-version]')!.getAttribute('title')).toMatch(/\nLast release 1h ago\.$/)
    const strip = document.querySelector('[data-release-strip]')!
    expect(strip).toHaveAttribute('data-release-tone', 'idle')
    expect(strip).toHaveAttribute('aria-label', 'Release stage 2 of 5: Release PR, not started')
    const dot = strip.querySelector('[data-strip-stage="pr"]')!
    expect(dot).toHaveClass('bg-transparent', 'border-fg-muted')
    expect(dot).not.toHaveClass('release-step-pulse')
    expect(dot).not.toHaveClass('bg-warn')
    expect(dot.closest('li')!.getAttribute('title')).toMatch(/^Release PR: not started\nNothing is running\./)
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
