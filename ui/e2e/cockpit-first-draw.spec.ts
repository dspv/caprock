/**
 * The right panel on a tab switch (owner, 2026-11-18, translated: "on the
 * right, CI statuses take a while; I switch to the tab and only after ~10 s
 * the CI data comes, and maybe Release"). The folded CI line is drawn from
 * the answer kept for that repository at once, with its age, while the read
 * runs; it never waits for the daemon's composition of a pull request's
 * checks, which takes seconds when the daemon has not composed it for that
 * session yet (measured 1.2 s and 15 s on 2026-11-18). GitHub is not
 * connected on the stand, so the Pipeline answer, the session's pull
 * requests and the checks are stubbed at the page, the checks slow on
 * purpose; nothing is typed into the fake claude.
 *
 * With CAPROCK_SHOTS_DIR set it also photographs the Release section in each
 * of its phases there (the PR's own verification, not a test).
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'

const now = Date.now()
const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
/** How slow the daemon is to compose a pull request's checks it has not composed for this session. */
const CHECKS_MS = Number(process.env.CAPROCK_CHECKS_MS || 5000)

const SPEND = { cost_usd: 0, sessions: 0, live: 0, agents: [] }
const FLOW = { counts: {}, days: 14, merged: 2, ttm_count: 0, release_lag_count: 0, cost_usd: 0 }
const RUNNING = { state: 'pending', passed: 8, failed: 0, pending: 3, items: [
  ...Array.from({ length: 8 }, (_, i) => ({ name: `check ${i}`, state: 'pass', started_at: now - 300_000, completed_at: now - 120_000 })),
  ...Array.from({ length: 3 }, (_, i) => ({ name: `go (windows-latest) ${i}`, state: 'pending', status: 'in_progress', started_at: now - 300_000 })),
] }
const live = (n: number, state: string, checks: object) => ({ number: n, url: `https://github.com/acme/app/pull/${n}`, title: `PR ${n}`, state, draft: false,
  review: '', reviews: [], branch: `feat/${n}`, base: 'master', mergeable: null, head_sha: `sha${n}`, checks, at: now })

/** The Pipeline answer: the release PR #942 open, #940 merged since v0.182.4. */
function stats(extra: object = {}) {
  return {
    connected: true, repo: 'acme/app', fetched_at: now - 20_000, read_at: now - 20_000,
    prs: [
      { number: 942, url: 'https://github.com/acme/app/pull/942', title: 'chore(release): 0.183.0', state: 'open', created_at: now - 300_000 },
      { number: 940, url: 'https://github.com/acme/app/pull/940', title: 'feat: a batch', state: 'merged', created_at: now - 7_200_000, merged_at: now - 1_800_000 },
    ],
    board: {
      cards: [
        { number: 942, stage: 'open', ci: 'running', stage_at: now - 300_000, spend: SPEND },
        { number: 940, stage: 'merged', stage_at: now - 1_800_000, spend: SPEND },
      ],
      releases: [{ tag: 'v0.182.4', published_at: now - 86_400_000, assets: 23, prs: [], cost_usd: 0, sessions: 0 }],
      flow: FLOW, ships_by: 'release',
    },
    ...extra,
  }
}

async function stub(page: Page, opts: { stats?: object; checksMs?: number } = {}) {
  const seen = new Set<string>()
  await page.route(/\/v1\/sessions\/[^/]+\/ci\/stats$/, (r) => r.fulfill(json(opts.stats ?? stats())))
  // The session's own pull request merged: the line is the repository's open one.
  await page.route(/\/v1\/sessions\/[^/]+\/prs$/, (r) => r.fulfill(json({ connected: true, fetched_at: now, prs: [
    { session_id: 'x', number: 940, url: 'https://github.com/acme/app/pull/940', title: 'feat: a batch', last_at: now, live: live(940, 'merged', { state: 'pass', passed: 1, failed: 0, pending: 0, items: [{ name: 'lint', state: 'pass' }] }) },
  ] })))
  // A pull request's checks: slow the first time each session asks, as the
  // daemon composes them (later reads answer from what it keeps).
  await page.route(/\/v1\/sessions\/([^/]+)\/ci\?pr=(\d+)$/, async (r: Route) => {
    const m = /\/v1\/sessions\/([^/]+)\/ci\?pr=(\d+)$/.exec(r.request().url())!
    const key = `${m[1]}:${m[2]}`
    if (!seen.has(key)) { seen.add(key); await new Promise((ok) => setTimeout(ok, opts.checksMs ?? CHECKS_MS)) }
    const n = Number(m[2])
    await r.fulfill(json({ connected: true, fetched_at: Date.now(), pr: { number: n, url: `https://github.com/acme/app/pull/${n}`, repo: 'acme/app', title: `PR ${n}`, state: 'open', live: live(n, 'open', RUNNING) } })).catch(() => {})
  })
}

test('a tab switch draws the folded CI line from the kept answer at once', async ({ app, page }) => {
  // A second session in alpha's repository, as the owner keeps several tabs
  // on one: the daemon has composed nothing for it yet.
  const alpha = app.session('alpha')
  const r = await fetch(`${app.stand.daemonURL}/v1/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: alpha.cwd }) })
  const { session_id: id } = await r.json() as { session_id: string }
  expect(r.ok && id, 'spawn a second session in alpha').toBeTruthy()
  try {
    await fetch(`${app.stand.daemonURL}/v1/sessions/${id}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'e2e gamma' }) })
    await page.addInitScript(() => {
      localStorage.setItem('caprock.app.cockpit-looks', JSON.stringify({ ci: 'compact', release: 'compact', changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact' }))
    })
    await stub(page)
    await app.open()
    const fold = page.locator('[data-cockpit-ci-fold]')
    await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
    await expect(fold).toHaveAttribute('data-cockpit-ci-fold', '942', { timeout: CHECKS_MS + 8_000 })
    // The other session of the same repository, never shown: timed from the click on its row.
    const t0 = Date.now()
    await app.row('e2e gamma').first().click()
    await expect(app.tabs.getByRole('tab', { name: /^e2e gamma/, selected: true })).toBeVisible()
    await expect(fold).toHaveAttribute('data-cockpit-ci-fold', '942', { timeout: CHECKS_MS + 8_000 })
    const first = Date.now() - t0
    // And back to alpha's tab.
    const t1 = Date.now()
    await app.tabs.getByRole('tab', { name: new RegExp(`^${alpha.name}`) }).click()
    await expect(fold).toHaveAttribute('data-cockpit-ci-fold', '942', { timeout: CHECKS_MS + 8_000 })
    const back = Date.now() - t1
    const said = `new tab in the same repository ${first} ms, back to a seen tab ${back} ms (checks read: ${CHECKS_MS} ms cold)`
    test.info().annotations.push({ type: 'tab switch → CI line', description: said })
    if (process.env.CAPROCK_MEASURE_OUT) writeFileSync(process.env.CAPROCK_MEASURE_OUT, `${said}\n`, { flag: 'a' })
    expect(first).toBeLessThan(1_500)
    expect(back).toBeLessThan(1_500)
  } finally {
    // This stand started it, so this stand stops it (rule 7).
    await fetch(`${app.stand.daemonURL}/v1/agents/${id}/signal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'kill' }) })
  }
})

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''

/** A phase of a release, as the stubs answer it: the Pipeline answer, the release run, the tags and changelog entries. */
interface Phase { name: string; line: RegExp; stats: object; run?: object; tag: string; entries: number }
const rel = (tag: string, ago: number, assets: number) => ({ tag, published_at: now - ago, assets, prs: [], cost_usd: 0, sessions: 0 })
const pr = (n: number, title: string, state: string, merged = 0) => ({ number: n, url: `https://github.com/acme/app/pull/${n}`, title, state, created_at: now - 3_600_000, ...(merged ? { merged_at: now - merged } : {}) })
const card = (n: number, stage: string, ci?: string) => ({ number: n, stage, ci, stage_at: now - 600_000, spend: SPEND })
const board = (cards: object[], releases: object[]) => ({ cards, releases, flow: FLOW, ships_by: 'release' })
const statsOf = (prs: object[], cards: object[], releases: object[]) => ({ connected: true, repo: 'acme/app', fetched_at: now, read_at: now, prs, board: board(cards, releases) })
const PHASES: Phase[] = [
  { name: 'idle', line: /^Nothing new since v0\.182\.4$/, tag: 'v0.182.4', entries: 0,
    stats: statsOf([pr(939, 'chore(release): 0.182.4', 'merged', 86_500_000)], [card(939, 'released')], [rel('v0.182.4', 86_400_000, 23)]) },
  { name: 'waiting', line: /^0\.183\.0 · 5 changes · next: merge #941$/, tag: 'v0.182.4', entries: 5,
    stats: statsOf([pr(941, 'feat: the next batch', 'open'), pr(940, 'feat: a batch', 'merged', 1_800_000)], [card(941, 'ready', 'pass'), card(940, 'merged')], [rel('v0.182.4', 86_400_000, 23)]) },
  { name: 'release-pr', line: /^0\.183\.0 · release PR #942 · CI running$/, tag: 'v0.182.4', entries: 5,
    stats: statsOf([pr(942, 'chore(release): 0.183.0', 'open'), pr(940, 'feat: a batch', 'merged', 1_800_000)], [card(942, 'open', 'running'), card(940, 'merged')], [rel('v0.182.4', 86_400_000, 23)]) },
  { name: 'building', line: /^0\.183\.0 · building · 12 of 23 files$/, tag: 'v0.183.0', entries: 0,
    stats: statsOf([pr(942, 'chore(release): 0.183.0', 'merged', 600_000), pr(940, 'feat: a batch', 'merged', 1_800_000)], [card(942, 'merged'), card(940, 'merged')], [rel('v0.183.0', 120_000, 12), rel('v0.182.4', 86_400_000, 23)]),
    run: { repo: 'acme/app', tag: 'v0.183.0', state: 'running', at: now, run: { id: 1, name: 'release', status: 'in_progress', conclusion: '', jobs: [] } } },
  { name: 'out', line: /^v0\.183\.0 out · 5 min ago$/, tag: 'v0.183.0', entries: 0,
    stats: statsOf([pr(942, 'chore(release): 0.183.0', 'merged', 1_200_000), pr(940, 'feat: a batch', 'merged', 1_800_000)], [card(942, 'released'), card(940, 'released')], [rel('v0.183.0', 300_000, 23), rel('v0.182.4', 86_400_000, 23)]),
    run: { repo: 'acme/app', tag: 'v0.183.0', state: 'pass', at: now, run: { id: 1, name: 'release', status: 'completed', conclusion: 'success', jobs: [] }, release: { url: 'https://github.com/acme/app/releases/tag/v0.183.0', published_at: now - 300_000 } } },
]

test('photographs the Release section in each phase, folded and unfolded', async ({ app, page }) => {
  test.skip(!shotsDir, 'CAPROCK_SHOTS_DIR is unset: the photographs are the PR’s own verification')
  let phase = PHASES[0]!
  await page.route(/\/v1\/sessions\/[^/]+\/ci\/stats$/, (r) => r.fulfill(json(phase.stats)))
  await page.route(/\/v1\/sessions\/[^/]+\/prs$/, (r) => r.fulfill(json({ connected: true, fetched_at: now, prs: [] })))
  await page.route(/\/v1\/sessions\/[^/]+\/ci\?pr=\d+$/, (r) => r.fulfill(json({ connected: true, fetched_at: now, pr: { number: 942, url: '', repo: 'acme/app', live: live(942, 'open', RUNNING) } })))
  await page.route(/\/v1\/sessions\/[^/]+\/ci\/release$/, (r) => r.fulfill(json({ connected: true, repo: 'acme/app', fetched_at: now, release: phase.run ?? { repo: 'acme/app', state: 'none', at: now } })))
  // The tags and changelog entries are this machine's: the stand's repository has none, so they are said here.
  await page.route(/\/v1\/work$/, async (r) => {
    const res = await r.fetch()
    const w = await res.json() as { repos?: { root: string; remote?: string; unreleased?: object; released?: object; tags?: object }[] }
    for (const x of w.repos ?? []) {
      x.remote = 'acme/app'
      x.tags = { last: { name: phase.tag, at: phase.tag === 'v0.183.0' ? now - 500_000 : now - 86_400_000 }, gaps: 0 }
      const kind = (i: number) => (i < 2 ? 'Added' : 'Fixed')
      x.unreleased = { ref: 'origin/master', items: Array.from({ length: phase.entries }, (_, i) => `entry ${i}`), count: phase.entries, kinds: phase.entries ? { Added: 2, Fixed: phase.entries - 2 } : {},
        entries: Array.from({ length: phase.entries }, (_, i) => ({ text: `Entry ${i}: what changed, written for a person reading the release notes, long enough to wrap onto a second line`, scope: 'ui', kind: kind(i), source: i % 2 ? 'pr' : 'master' })) }
      // The release's own notes once its pull request merged: the CHANGELOG's section by that version.
      if (phase.tag === 'v0.183.0') x.released = { version: '0.183.0', count: 2, entries: [{ text: 'A feature that shipped in 0.183.0', kind: 'Added' }, { text: 'A fix that shipped in 0.183.0', kind: 'Fixed' }] }
    }
    await r.fulfill({ response: res, json: w })
  })
  const looks = (release: 'compact' | 'full') => page.evaluate((v) => localStorage.setItem('caprock.app.cockpit-looks', JSON.stringify({
    ci: 'compact', release: v, changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact', subagents: 'compact', tools: 'compact',
  })), release)
  await app.open()
  const alpha = app.session('alpha')
  await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  for (const p of PHASES) {
    phase = p
    // A fresh start of the page per phase: nothing kept from the one before.
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.includes('deck:')) localStorage.removeItem(k) })
    await looks('compact')
    await page.reload()
    await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${alpha.name}`), selected: true })).toBeVisible()
    const fold = inspector.locator('[data-release-fold]')
    await expect(fold).toHaveAttribute('aria-label', p.line)
    await page.waitForTimeout(300)
    await inspector.screenshot({ path: path.join(shotsDir, `${p.name}-folded.png`) })
    await looks('full')
    await page.reload()
    await expect(inspector.locator('section[aria-label="Release"]')).toBeVisible()
    await page.waitForTimeout(600)
    const release = inspector.locator('[data-section-frame="release"]')
    await release.scrollIntoViewIfNeeded()
    await release.screenshot({ path: path.join(shotsDir, `${p.name}-unfolded.png`) })
  }
})

// Owner, 2026-11-18: "#941 ✕ 1 failed ● 1 running ✓ 12 · 2 skipped" ran past
// the panel's right edge. At every width the folded CI line shortens; its
// age stays one line.
test('the folded CI line shortens at narrow widths and never passes the edge', async ({ app, page }) => {
  const MIXED = { state: 'pending', passed: 12, failed: 1, pending: 1, items: [
    { name: 'lint', state: 'fail', started_at: now - 300_000, completed_at: now - 200_000 },
    { name: 'go (windows-latest)', state: 'pending', status: 'in_progress', started_at: now - 300_000 },
    ...Array.from({ length: 12 }, (_, i) => ({ name: `check ${i}`, state: 'pass', started_at: now - 300_000, completed_at: now - 120_000 })),
    { name: 'skip a', state: 'skipped' }, { name: 'skip b', state: 'skipped' },
  ] }
  await page.route(/\/v1\/sessions\/[^/]+\/ci\/stats$/, (r) => r.fulfill(json(stats())))
  await page.route(/\/v1\/sessions\/[^/]+\/prs$/, (r) => r.fulfill(json({ connected: true, fetched_at: now, prs: [] })))
  await page.route(/\/v1\/sessions\/[^/]+\/ci\?pr=\d+$/, (r) => r.fulfill(json({ connected: true, fetched_at: now, pr: { number: 942, url: '', repo: 'acme/app', live: live(942, 'open', MIXED) } })))
  await page.addInitScript(() => {
    localStorage.setItem('caprock.app.cockpit-looks', JSON.stringify({ ci: 'compact', release: 'compact', changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact' }))
  })
  await app.open()
  const alpha = app.session('alpha')
  await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const fold = inspector.locator('[data-cockpit-ci-fold]')
  await expect(fold).toHaveAttribute('data-cockpit-ci-fold', '942')
  for (const w of [280, 300, 324, 360, 460]) {
    await page.evaluate((px) => document.documentElement.style.setProperty('--app-inspector-w', `${px}px`), w)
    await page.waitForTimeout(200)
    const over = await page.evaluate(() => {
      const head = document.querySelector('section[aria-label="CI"] [data-section-head]') as HTMLElement
      const edge = head.getBoundingClientRect().right + 0.5
      const out: string[] = []
      for (const el of head.querySelectorAll<HTMLElement>('span, button')) {
        if (el.closest('.invisible') || el.offsetWidth === 0) continue
        const r = el.getBoundingClientRect()
        if (r.right > edge) out.push(`"${el.textContent}" ends at ${Math.round(r.right)} > ${Math.round(edge)}`)
      }
      const age = head.querySelector('[data-cockpit-ci-age]') as HTMLElement
      if (age.getBoundingClientRect().height > 20) out.push(`age wraps: ${age.textContent}`)
      return out
    })
    expect(over, `at ${w}px`).toEqual([])
    if (shotsDir) await inspector.locator('[data-section-frame="ci"]').screenshot({ path: path.join(shotsDir, `ci-fold-${w}.png`) })
  }
})

// Owner, 2026-11-19: the word strip wrapped "Published" to a second line at
// 330px. Variant A's dots and one named stage stay one line, and nothing in
// the unfolded section passes the panel's edge, at every width.
test('the unfolded Release section keeps its stage dots on one line and inside the edge', async ({ app, page }) => {
  const os = [{ os: 'linux', state: 'pass', checks: 4 }, { os: 'macos', state: 'running', checks: 4 }, { os: 'windows', state: 'running', checks: 4 }]
  const cases = [
    { name: 'release-pr', words: /^checks 1 of 3 systems$/,
      stats: statsOf([pr(942, 'chore(release): 0.183.0', 'open'), pr(940, 'feat: a batch', 'merged', 1_800_000)], [{ ...card(942, 'open', 'running'), os }, card(940, 'merged')], [rel('v0.182.4', 86_400_000, 23)]) },
    { name: 'waiting', words: /^Waiting for #941 · ready to merge$/,
      stats: statsOf([pr(941, 'feat: the next batch with a title long enough to fill the line', 'open')], [card(941, 'ready', 'pass')], [rel('v0.182.4', 86_400_000, 23)]), onPR: true },
  ]
  let c = cases[0]!
  await page.route(/\/v1\/sessions\/[^/]+\/ci\/stats$/, (r) => r.fulfill(json(c.stats)))
  await page.route(/\/v1\/sessions\/[^/]+\/prs$/, (r) => r.fulfill(json({ connected: true, fetched_at: now, prs: [] })))
  await page.route(/\/v1\/sessions\/[^/]+\/ci\?pr=\d+$/, (r) => r.fulfill(json({ connected: true, fetched_at: now, pr: { number: 942, url: '', repo: 'acme/app', live: live(942, 'open', RUNNING) } })))
  await page.route(/\/v1\/sessions\/[^/]+\/ci\/release$/, (r) => r.fulfill(json({ connected: true, repo: 'acme/app', fetched_at: now, release: { repo: 'acme/app', state: 'none', at: now } })))
  await page.route(/\/v1\/work$/, async (r) => {
    const res = await r.fetch()
    const w = await res.json() as { repos?: { root: string; remote?: string; unreleased?: object; tags?: object }[] }
    for (const x of w.repos ?? []) {
      x.remote = 'acme/app'
      x.tags = { last: { name: 'v0.182.4', at: now - 86_400_000 }, gaps: 0 }
      const source = (i: number) => ('onPR' in c ? 'pr' : i % 2 ? 'pr' : 'master')
      x.unreleased = { ref: 'origin/master', items: ['a', 'b', 'c'], count: 3, kinds: { Changed: 1, Fixed: 2 }, ...('onPR' in c ? { via: { number: 941, head: 'feat/batch', sha: 'abc' } } : {}),
        entries: [0, 1, 2].map((i) => ({ text: `Entry ${i}: what changed, written for a person reading the release notes, long enough to wrap onto a second line`, scope: 'ui', kind: i ? 'Fixed' : 'Changed', source: source(i) })) }
    }
    await r.fulfill({ response: res, json: w })
  })
  await page.addInitScript(() => {
    localStorage.setItem('caprock.app.cockpit-looks', JSON.stringify({ ci: 'compact', release: 'full', changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact', subagents: 'compact', tools: 'compact' }))
  })
  await app.open()
  const alpha = app.session('alpha')
  await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  for (const k of cases) {
    c = k
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.includes('deck:')) localStorage.removeItem(key) })
    await page.reload()
    await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${alpha.name}`), selected: true })).toBeVisible()
    const words = inspector.locator('section[aria-label="Release"] [data-release-stage-words]')
    await expect(words).toHaveText(k.words)
    for (const w of [280, 300, 330, 360, 460]) {
      await page.evaluate((px) => document.documentElement.style.setProperty('--app-inspector-w', `${px}px`), w)
      await page.waitForTimeout(200)
      const over = await page.evaluate(() => {
        const sec = document.querySelector('section[aria-label="Release"]') as HTMLElement
        const edge = sec.getBoundingClientRect().right + 0.5
        const out: string[] = []
        for (const el of sec.querySelectorAll<HTMLElement>('[data-release-plan] *')) {
          if (el.offsetWidth === 0) continue
          const r = el.getBoundingClientRect()
          if (r.right > edge) out.push(`"${(el.textContent ?? '').slice(0, 40)}" ends at ${Math.round(r.right)} > ${Math.round(edge)}`)
        }
        const strip = sec.querySelector('[data-release-strip]') as HTMLElement
        if (strip.getBoundingClientRect().height > 18) out.push(`the stage row wraps: ${strip.getBoundingClientRect().height}px`)
        const words = strip.querySelector('[data-release-stage-words]') as HTMLElement
        if (words.getBoundingClientRect().height > 18) out.push(`the stage words wrap: ${words.textContent}`)
        for (const line of sec.querySelectorAll<HTMLElement>('[data-release-via], [data-release-section="branch"]')) {
          if (line.getBoundingClientRect().height > 20) out.push(`wraps: ${line.textContent}`)
        }
        return out
      })
      expect(over, `${k.name} at ${w}px`).toEqual([])
      if (shotsDir) await inspector.locator('[data-section-frame="release"]').screenshot({ path: path.join(shotsDir, `release-dots-${k.name}-${w}.png`) })
    }
  }
})

// Owner, 2026-11-20, on the cockpit at ~330 px (translated): the Fix CI
// confirm wrapped onto two lines, two links under the list said nearly the
// same, the Release section was cut and said #977 and CI red twice, and CI
// showed a stale red on open until something was clicked.
const FAILING = { state: 'fail', passed: 10, failed: 1, pending: 0, items: [
  { name: 'e2e (headless shell)', state: 'fail', started_at: now - 600_000, completed_at: now - 60_000 },
  ...Array.from({ length: 10 }, (_, i) => ({ name: `check ${i}`, state: 'pass', started_at: now - 600_000, completed_at: now - 120_000 })),
] }
const BATCH_TITLE = 'fix(agents): a session that dies on its own says so in its tab'
const polishStats = (readAt: number, card: object = { number: 977, stage: 'fix', ci: 'fail', why: 'ci', failed: ['e2e (headless shell)'], stage_at: now - 600_000, spend: SPEND }) => ({
  connected: true, repo: 'acme/app', fetched_at: readAt, read_at: readAt,
  prs: [{ number: 977, url: 'https://github.com/acme/app/pull/977', title: BATCH_TITLE, state: 'open', created_at: now - 3_600_000 }],
  board: { cards: [card], releases: [{ tag: 'v0.185.2', published_at: now - 36 * 60_000, assets: 23, prs: [], cost_usd: 0, sessions: 0 }], flow: FLOW, ships_by: 'release' },
})
const GH = { connected: true, source: 'token', user: { login: 'ada' }, scopes: ['repo'], scopes_known: true, token_kind: 'classic',
  sources: { gh: false, stored: true, store: 'file', oauth: false }, health: { last_ok_at: now }, notify: true, auto_rerun: false, tracked: 0 }

async function polishStub(page: Page, statsAnswer: () => object | Promise<object>) {
  await page.route(/\/v1\/github$/, (r) => r.fulfill(json(GH)))
  await page.route(/\/v1\/sessions\/[^/]+\/ci\/stats$/, async (r) => { const b = await statsAnswer(); await r.fulfill(json(b)).catch(() => {}) })
  await page.route(/\/v1\/sessions\/([^/]+)\/prs$/, (r) => {
    const id = /\/v1\/sessions\/([^/]+)\/prs$/.exec(r.request().url())![1]
    return r.fulfill(json({ connected: true, fetched_at: Date.now(), prs: [{ session_id: id, number: 977, url: 'https://github.com/acme/app/pull/977', title: BATCH_TITLE, last_at: now,
      live: { ...live(977, 'open', FAILING), title: BATCH_TITLE, mergeable: true, mergeable_state: 'unstable' } }] }))
  })
  await page.route(/\/v1\/sessions\/[^/]+\/ci\?pr=\d+$/, (r) => r.fulfill(json({ connected: true, fetched_at: Date.now(), pr: { number: 977, url: '', repo: 'acme/app', live: live(977, 'open', FAILING) } })))
  await page.route(/\/v1\/sessions\/[^/]+\/ci\/release$/, (r) => r.fulfill(json({ connected: true, repo: 'acme/app', fetched_at: now, release: { repo: 'acme/app', state: 'none', at: now } })))
  await page.route(/\/v1\/work$/, async (r) => {
    const res = await r.fetch()
    const w = await res.json() as { repos?: { root: string; remote?: string; unreleased?: object; tags?: object }[] }
    for (const x of w.repos ?? []) {
      x.remote = 'acme/app'
      x.tags = { last: { name: 'v0.185.2', at: now - 36 * 60_000 }, gaps: 0 }
      x.unreleased = { ref: 'origin/master', items: ['a', 'b'], count: 2, kinds: { Fixed: 2 }, via: { number: 977, head: 'fix/agents-die', sha: 'abc' },
        entries: [
          { text: 'A session that dies on its own says so in its tab, with Resume, and is in Recently closed', scope: 'agents', kind: 'Fixed', source: 'pr' },
          { text: 'A run-out time names its day, countdowns close up (2d 16h)', scope: 'limits', kind: 'Fixed', source: 'pr' },
        ] }
    }
    await r.fulfill({ response: res, json: w })
  })
}

const looksAll = (page: Page) => page.addInitScript(() => {
  localStorage.setItem('caprock.app.cockpit-looks', JSON.stringify({ ci: 'full', release: 'full', changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact', subagents: 'compact', tools: 'compact' }))
})

/** The elements matched whose text is cut (an ellipsis drawn): their content is wider than their box. */
const cut = (page: Page, sel: string) => page.evaluate((s) => [...document.querySelectorAll<HTMLElement>(s)]
  .filter((e) => e.offsetWidth > 0 && e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent ?? ''), sel)

test('at 330 px: the Fix CI confirm is one line, one Pipeline link, and the Release section reads cleanly', async ({ app, page }) => {
  await polishStub(page, () => polishStats(Date.now()))
  await looksAll(page)
  await app.open()
  const alpha = app.session('alpha')
  await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
  await page.evaluate(() => document.documentElement.style.setProperty('--app-inspector-w', '330px'))
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const ci = inspector.locator('section[aria-label="CI"]')
  await expect(ci.locator('[data-cockpit-ci-pr="977"]')).toBeVisible()

  // One link under the list: the failing PR's log in the Pipeline.
  await expect(ci.locator('[data-cockpit-ci-open]')).toHaveCount(1)
  await expect(ci.locator('[data-cockpit-ci-open]')).toHaveText('#977 log in Pipeline →')
  await expect(ci.locator('[data-cockpit-ci-log]')).toHaveCount(0)
  if (shotsDir) await inspector.locator('[data-section-frame="ci"]').screenshot({ path: path.join(shotsDir, 'polish-ci-330.png') })

  // Fix CI asks in one line, the whole sentence on hover.
  const action = ci.locator('[data-cockpit-ci-pr="977"] [data-cockpit-ci-action="ci"]')
  await expect(action).toBeEnabled()
  await action.click()
  const confirm = ci.locator('[data-cockpit-ci-confirm]')
  await expect(confirm).toBeVisible()
  await expect(confirm.locator('[data-cockpit-ci-confirm-text]')).toHaveText(/^(Ask|New agent) to fix #977 CI\?$/)
  await expect(confirm.locator('[data-cockpit-ci-confirm-text]')).toHaveAttribute('title', /#977’s CI and push\?/)
  expect((await confirm.boundingBox())!.height, 'the confirm is one line').toBeLessThan(22)
  expect(await cut(page, '[data-cockpit-ci-confirm-text]'), 'the question is not cut').toEqual([])
  if (shotsDir) await inspector.locator('[data-section-frame="ci"]').screenshot({ path: path.join(shotsDir, 'polish-ci-confirm-330.png') })
  await confirm.getByRole('button', { name: 'Cancel' }).click()

  // The Release section: shortened, never cut, the batch said once.
  const rel = inspector.locator('section[aria-label="Release"]')
  const head = rel.locator('[data-release-head]')
  await expect(head).toBeVisible()
  expect(await head.evaluate((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim())).toMatch(/^Next 0\.185\.3 ?· ?patch ?· ?36m ago$/)
  expect(await cut(page, 'section[aria-label="Release"] [data-release-head] *'), 'the heading is not cut').toEqual([])
  const words = rel.locator('[data-release-stage-words]')
  await expect(words).toHaveText('Waiting for #977 · CI red')
  await expect(words).toHaveAttribute('title', /Failed: e2e \(headless shell\)\./)
  await expect(words).toHaveClass(/text-danger/)
  expect(await cut(page, 'section[aria-label="Release"] [data-release-stage-words]'), 'the stage words are not cut').toEqual([])
  await expect(rel.locator('[data-release-via]')).toHaveCount(0)
  expect((await rel.locator('[data-release-plan]').innerText()).match(/#977/g)).toHaveLength(1)
  await rel.scrollIntoViewIfNeeded()
  if (shotsDir) await inspector.locator('[data-section-frame="release"]').screenshot({ path: path.join(shotsDir, 'polish-release-330.png') })
})

test('a kept CI copy is faint, as of its age, until the read lands; the window coming to the front reads at once', async ({ app, page }) => {
  test.setTimeout(60_000)
  // The first load keeps an answer GitHub gave 25 minutes ago.
  let mode: 'old' | 'slow' = 'old'
  let asks = 0
  await polishStub(page, async () => {
    asks++
    if (mode === 'old') return polishStats(now - 25 * 60_000)
    await new Promise((ok) => setTimeout(ok, 3_000))
    return polishStats(Date.now(), { number: 977, stage: 'ready', ci: 'pass', stage_at: now - 60_000, spend: SPEND })
  })
  await looksAll(page)
  await app.open()
  const alpha = app.session('alpha')
  await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const ci = inspector.locator('section[aria-label="CI"]')
  await expect(ci.locator('[data-cockpit-ci-pr="977"]')).toBeVisible()
  // The window opens again on that kept copy while GitHub is read: faint,
  // as of its age, never a full-strength red.
  mode = 'slow'
  await page.reload()
  await page.evaluate(() => document.documentElement.style.setProperty('--app-inspector-w', '330px'))
  const body = ci.locator('[data-cockpit-ci-body-kept]')
  await expect(body).toBeVisible()
  await expect(ci.locator('[data-cockpit-ci-age]')).toHaveText(/^as of 2[5-6] min ago$/)
  await expect(inspector.locator('section[aria-label="Release"] [data-release-strip]')).toHaveAttribute('data-release-kept', '')
  await expect(inspector.locator('[data-release-kept-age]')).toHaveText(/^as of 2[5-6] min ago$/)
  expect(Number(await body.evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(0.8)
  if (shotsDir) await inspector.screenshot({ path: path.join(shotsDir, 'polish-kept-faint-330.png') })
  // The read lands: full strength, its own age.
  await expect(body).toHaveCount(0, { timeout: 8_000 })
  await expect(ci.locator('[data-cockpit-ci-age]')).toHaveText(/^(now|\d+ s ago)$/)
  await expect(inspector.locator('section[aria-label="Release"] [data-release-strip]')).not.toHaveAttribute('data-release-kept', '')
  if (shotsDir) await inspector.screenshot({ path: path.join(shotsDir, 'polish-kept-fresh-330.png') })
  // Brought to the front (shown beside another window, not covered): asked at once, not at the next minute.
  await page.waitForTimeout(5_500)
  const before = asks
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => asks, { timeout: 1_500 }).toBeGreaterThan(before)
})
