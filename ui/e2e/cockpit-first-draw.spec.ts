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
import { expect, stopAgent, test } from './fixtures'

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
    // The one shown: the bodies of tabs shown before stay drawn, hidden (components/KeptViews).
    const fold = page.locator('[data-cockpit-ci-fold]').filter({ visible: true })
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
    // This stand started it, so this stand stops it (rule 7) — with the page
    // closed first: a tab still open on it would become a shell in its place.
    await page.close()
    await stopAgent(app.stand.daemonURL, id)
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
    ci: 'compact', release: v, changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact', tools: 'compact',
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
  const fold = inspector.locator('[data-cockpit-ci-fold]').filter({ visible: true })
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

/** The theme for a photograph, as the app sets it. */
async function theme(page: Page, which: 'dark' | 'light') {
  await page.evaluate((w) => {
    const el = document.documentElement
    el.removeAttribute('data-dark')
    el.removeAttribute('data-tone')
    el.setAttribute('data-theme', w)
    el.setAttribute(w === 'dark' ? 'data-dark' : 'data-tone', w === 'dark' ? 'pastel' : 'white')
  }, which)
}

// Owner, 2026-11-24, variant A: within the hour of a release the folded
// line's version is a green pill with the release's agent cost beside its
// age, on the same one 16px line, inside the panel's edge at every width,
// the parts that do not fit going whole, the last first. The burst plays
// once per tag and viewer: a reload does not replay it.
/** A release published `ago` ms before, its agent cost recorded: the stubs for the Release section within the hour. */
async function stubReleased(page: Page, ago: number) {
  const out = { ...rel('v0.183.0', ago, 23), cost_usd: 17.25, prs: [942, 940, 939], sessions: 2 }
  const s = statsOf([pr(942, 'chore(release): 0.183.0', 'merged', 600_000)], [card(942, 'released')], [out, rel('v0.182.4', 86_400_000, 23)])
  await page.route(/\/v1\/sessions\/[^/]+\/ci\/stats$/, (r) => r.fulfill(json(s)))
  await page.route(/\/v1\/sessions\/[^/]+\/prs$/, (r) => r.fulfill(json({ connected: true, fetched_at: now, prs: [] })))
  await page.route(/\/v1\/sessions\/[^/]+\/ci\?pr=\d+$/, (r) => r.fulfill(json({ connected: true, fetched_at: now, pr: { number: 942, url: '', repo: 'acme/app', live: live(942, 'merged', RUNNING) } })))
  await page.route(/\/v1\/sessions\/[^/]+\/ci\/release$/, (r) => r.fulfill(json({ connected: true, repo: 'acme/app', fetched_at: now,
    release: { repo: 'acme/app', tag: 'v0.183.0', state: 'pass', at: now, run: { id: 1, name: 'release', status: 'completed', conclusion: 'success', jobs: [] }, release: { url: '', published_at: now - ago } } })))
  await page.route(/\/v1\/work$/, async (r) => {
    const res = await r.fetch()
    const w = await res.json() as { repos?: { root: string; remote?: string; unreleased?: object; tags?: object }[] }
    for (const x of w.repos ?? []) {
      x.remote = 'acme/app'
      x.tags = { last: { name: 'v0.183.0', at: now - 500_000 }, gaps: 0 }
      x.unreleased = { ref: 'origin/master', items: [], count: 0, kinds: {} }
    }
    await r.fulfill({ response: res, json: w })
  })
}

test('the folded released line: a green pill and the agent cost, inside the edge', async ({ app, page }) => {
  await stubReleased(page, 4 * 60_000)
  await page.addInitScript(() => {
    localStorage.setItem('caprock.app.cockpit-looks', JSON.stringify({ ci: 'compact', release: 'compact', changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact', tools: 'compact' }))
  })
  await app.open()
  if (shotsDir) await theme(page, 'dark')
  const alpha = app.session('alpha')
  await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const fold = inspector.locator('[data-release-fold]')
  await expect(fold).toHaveAttribute('aria-label', /^0\.183\.0 released · 4 min ago · \$17\.25$/)
  await expect(fold.locator('[data-release-pill]')).toHaveText('0.183.0 released')
  await expect(fold.locator('[data-release-fold-cost]')).toHaveAttribute('title', /^\$17\.25 agents spent on 3 pull requests, 2 sessions/)
  // Seen once: the tag is kept, so a reload draws the pill without a burst.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('caprock.release-burst'))).toMatch(/"v0\.183\.0"/)
  // The section with room around it: the burst flies past the line.
  const shot = async (name: string) => {
    if (!shotsDir) return
    await theme(page, name.endsWith('-dark') ? 'dark' : 'light')
    await page.waitForTimeout(100)
    const b = (await inspector.locator('[data-section-frame="release"]').boundingBox())!
    await page.screenshot({ path: path.join(shotsDir, `${name}.png`), clip: { x: b.x - 12, y: b.y - 24, width: b.width + 24, height: b.height + 48 } })
  }
  if (shotsDir) {
    // The burst mid-flight, then still.
    await page.waitForTimeout(250)
    await shot('released-burst-dark')
  }
  await page.reload()
  if (shotsDir) await theme(page, 'dark')
  await expect(fold.locator('[data-release-pill]')).toHaveText('0.183.0 released')
  await page.waitForTimeout(150)
  await expect(page.locator('[data-release-burst]')).toHaveCount(0)
  for (const w of [280, 300, 330, 360, 460]) {
    await page.evaluate((px) => document.documentElement.style.setProperty('--app-inspector-w', `${px}px`), w)
    await page.waitForTimeout(200)
    const got = await page.evaluate(() => {
      const line = document.querySelector('[data-release-fold]') as HTMLElement
      const head = line.closest('[data-section-head]') as HTMLElement ?? line.parentElement!
      const edge = head.getBoundingClientRect().right + 0.5
      const top = line.getBoundingClientRect().top
      const out: string[] = []
      if (Math.round(line.getBoundingClientRect().height) !== 16) out.push(`the line is ${line.getBoundingClientRect().height}px high`)
      // What is on view: the parts on the line's first row (the rest wrap under it and are clipped).
      const shown: string[] = []
      for (const el of line.querySelectorAll<HTMLElement>('[data-release-fold-part]')) {
        const r = el.getBoundingClientRect()
        if (el.offsetWidth === 0 || r.top - top > 4) continue
        shown.push((el.textContent ?? '').replace(/^·\s*/, ''))
        if (r.right > edge) out.push(`"${el.textContent}" ends at ${Math.round(r.right)} > ${Math.round(edge)}`)
      }
      const pill = line.querySelector('[data-release-pill]') as HTMLElement
      const t = pill.querySelector('span') as HTMLElement
      return { out, shown, pillCut: t.scrollWidth > t.clientWidth + 0.5, pillH: pill.getBoundingClientRect().height }
    })
    expect(got.out, `at ${w}px`).toEqual([])
    expect(got.pillH, `at ${w}px`).toBeLessThanOrEqual(16)
    expect(got.shown[0], `at ${w}px`).toBe('0.183.0 released')
    expect(got.pillCut, `the pill cut at ${w}px`).toBe(false)
    // Whole parts only, in the line's order; narrow, the age goes before the cost.
    expect([['0.183.0 released', '4 min ago', '$17.25'], ['0.183.0 released', '$17.25'], ['0.183.0 released']].map((x) => x.join('|')), `at ${w}px`).toContain(got.shown.join('|'))
    // The pill and the cost on view at the narrowest and the widest panel; all three wide.
    if (w === 280) expect(got.shown, 'at 280px').toContain('$17.25')
    if (w === 460) expect(got.shown, 'at 460px').toEqual(['0.183.0 released', '4 min ago', '$17.25'])
    if (w === 460) await shot('released-460-dark')
    if (w === 280) await shot('released-280-dark')
  }
  if (shotsDir) {
    await theme(page, 'light')
    await page.waitForTimeout(200)
    await shot('released-460-light')
    await page.evaluate(() => document.documentElement.style.setProperty('--app-inspector-w', '280px'))
    await page.waitForTimeout(200)
    await shot('released-280-light')
    // The burst once more for its photograph, light: a fresh viewer.
    await page.evaluate(() => { localStorage.removeItem('caprock.release-burst'); document.documentElement.style.setProperty('--app-inspector-w', '460px') })
    await page.reload()
    await theme(page, 'light')
    await expect(page.locator('[data-release-burst]')).toHaveCount(1)
    await page.waitForTimeout(250)
    await shot('released-burst-light')
  }
})

// Owner, 2026-11-24, translated, of the unfolded section after a release:
// "is it supposed to be like this? where is it", then "this could be
// prettier" (variant A). Unfolded, the heading is a green seal with *0.183.0
// is out* over its age and cost, the five steps folded into a thin finished
// track under it; the burst plays once per tag whichever way it is first
// seen, unfolded from the seal.
test('the unfolded released heading: a seal, the version, age and cost, a finished track, one burst', async ({ app, page }) => {
  await stubReleased(page, 23 * 60_000)
  // Folded on the first load only: the fold the viewer picks then is kept.
  await page.addInitScript(() => {
    if (localStorage.getItem('caprock.app.cockpit-looks')) return
    localStorage.setItem('caprock.app.cockpit-looks', JSON.stringify({ ci: 'compact', release: 'compact', changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact', tools: 'compact' }))
  })
  await app.open()
  const alpha = app.session('alpha')
  await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const sec = inspector.locator('section[aria-label="Release"]')
  const toggle = sec.locator('[data-section-head] > button')
  const burstKept = () => page.evaluate(() => localStorage.getItem('caprock.release-burst'))
  // Folded first: the folded line is as it was, it bursts there, and unfolding does not burst again.
  await expect(sec.locator('[data-release-fold] [data-release-pill]')).toHaveText('0.183.0 released')
  await expect.poll(burstKept).toMatch(/"v0\.183\.0"/)
  await expect(page.locator('[data-release-burst]')).toHaveCount(0, { timeout: 3_000 })
  await toggle.click()
  const head = sec.locator('[data-release-head="out"]')
  await expect(head.locator('h3')).toHaveText('0.183.0 is out')
  await expect(head.locator('h3')).toHaveAttribute('aria-label', '0.183.0 is out · 23 min ago · $17.25 on 3 pull requests')
  await expect(head.locator('[data-release-seal]')).toBeVisible()
  await expect(head.locator('[data-release-fold-cost]')).toHaveText('$17.25')
  await expect(head.locator('[data-release-pill]')).toHaveCount(0)
  await page.waitForTimeout(150)
  await expect(page.locator('[data-release-burst]')).toHaveCount(0)
  // Said once: no stepper, no words; the track names the steps on hover.
  await expect(sec.locator('[data-release-strip]')).toHaveCount(0)
  await expect(sec.locator('[data-release-stage-words]')).toHaveCount(0)
  const track = head.locator('[data-release-track]')
  await expect(track).toHaveAttribute('title', /^Release 0\.183\.0: Merged: done · Release PR: done · Tagged: done, .+ · Building: done · Published: done, .+$/)
  await track.focus()
  await expect(track).toBeFocused()
  // A fresh viewer unfolded: it bursts from the seal, and folding does not burst again.
  await page.evaluate(() => localStorage.removeItem('caprock.release-burst'))
  await page.reload()
  await expect(head.locator('[data-release-seal]')).toBeVisible()
  await expect(page.locator('[data-release-burst]')).toHaveCount(1)
  const from = await page.evaluate(() => {
    const b = document.querySelector('[data-release-burst]') as HTMLElement
    const s = document.querySelector('[data-release-seal]')!.getBoundingClientRect()
    return { dx: Math.abs(parseFloat(b.style.left) - (s.left + s.width / 2)), dy: Math.abs(parseFloat(b.style.top) - (s.top + s.height / 2)) }
  })
  expect(from.dx, 'the burst from the seal').toBeLessThan(2)
  expect(from.dy, 'the burst from the seal').toBeLessThan(2)
  await expect.poll(burstKept).toMatch(/"v0\.183\.0"/)
  await expect(page.locator('[data-release-burst]')).toHaveCount(0, { timeout: 3_000 })
  await toggle.click()
  await expect(sec.locator('[data-release-fold] [data-release-pill]')).toHaveText('0.183.0 released')
  await page.waitForTimeout(150)
  await expect(page.locator('[data-release-burst]')).toHaveCount(0)
  await toggle.click()
  await expect(head.locator('[data-release-seal]')).toBeVisible()
  const shot = async (name: string) => {
    if (!shotsDir) return
    await page.waitForTimeout(100)
    const b = (await inspector.locator('[data-section-frame="release"]').boundingBox())!
    await page.screenshot({ path: path.join(shotsDir, `${name}.png`), clip: { x: b.x - 12, y: b.y - 12, width: b.width + 24, height: b.height + 24 } })
  }
  // 190 and 150 past the panel's range: the drop order, not a width it takes.
  for (const w of [280, 300, 330, 360, 460, 190, 150]) {
    await page.evaluate((px) => document.documentElement.style.setProperty('--app-inspector-w', `${px}px`), w)
    await page.waitForTimeout(200)
    const got = await page.evaluate(() => {
      const sec = document.querySelector('section[aria-label="Release"]') as HTMLElement
      const h = sec.querySelector('[data-release-head="out"] h3') as HTMLElement
      const line = sec.querySelector('[data-release-seal-line]') as HTMLElement
      const seal = sec.querySelector('[data-release-seal]') as HTMLElement
      const edge = sec.getBoundingClientRect().right + 0.5
      const out: string[] = []
      if (Math.round(line.getBoundingClientRect().height) !== 16) out.push(`line 2 is ${line.getBoundingClientRect().height}px high`)
      if (Math.round(seal.getBoundingClientRect().width) !== 30) out.push(`the seal is ${seal.getBoundingClientRect().width}px wide`)
      if (h.scrollWidth > h.clientWidth + 0.5) out.push('the version is cut')
      for (const el of sec.querySelectorAll<HTMLElement>('[data-release-plan] *')) {
        if (el.offsetWidth === 0) continue
        const r = el.getBoundingClientRect()
        if (r.right > edge) out.push(`"${(el.textContent ?? '').slice(0, 40)}" ends at ${Math.round(r.right)} > ${Math.round(edge)}`)
      }
      // Line 2's parts on view, each whole and inside the line.
      const lineR = line.getBoundingClientRect().right + 0.5
      const shown: string[] = []
      for (const el of line.querySelectorAll<HTMLElement>(':scope > span')) {
        if (el.offsetWidth === 0) continue
        if (el.scrollWidth > el.clientWidth + 0.5) out.push(`"${el.textContent}" is cut`)
        if (el.getBoundingClientRect().right > lineR) out.push(`"${el.textContent}" passes line 2's end`)
        shown.push((el.textContent ?? '').replace(/\s*·$/, ''))
      }
      const steps = [...sec.querySelectorAll<HTMLElement>('[data-track-step]')].map((e) => e.getBoundingClientRect())
      if (steps.length !== 5 || steps.some((r) => r.width < 10 || Math.round(r.height) !== 3)) out.push(`the track: ${steps.map((r) => `${r.width}x${r.height}`).join(', ')}`)
      return { out, shown, h1: parseFloat(getComputedStyle(h).fontSize) }
    })
    // Below the panel's 280px the version may truncate; nothing else may.
    expect(got.out.filter((x) => w >= 280 || x !== 'the version is cut'), `at ${w}px`).toEqual([])
    expect(got.h1, 'the version, the largest text').toBe(15)
    // *on N pull requests* goes first, then the age; the cost stays.
    expect([['23 min ago', '$17.25', 'on 3 pull requests'], ['23 min ago', '$17.25'], ['$17.25']].map((x) => x.join('|')), `at ${w}px`).toContain(got.shown.join('|'))
    if (w === 460) expect(got.shown, 'at 460px').toEqual(['23 min ago', '$17.25', 'on 3 pull requests'])
    if (w === 190) expect(got.shown, 'at 190px').toEqual(['23 min ago', '$17.25'])
    if (w === 150) expect(got.shown, 'at 150px').toEqual(['$17.25'])
    if (shotsDir && (w === 280 || w === 460)) {
      for (const th of ['dark', 'light'] as const) {
        await theme(page, th)
        await shot(`seal-${w}-${th}`)
      }
    }
  }
})

// Owner, 2026-11-19: the word strip wrapped "Published" to a second line at
// 330px; 2026-11-23, variant A: the steps across the panel with one word
// each stay one row, the state under them is whole (two lines at most,
// never an ellipsis), and nothing in the unfolded section passes the
// panel's edge, at every width.
test('the unfolded Release section keeps its stepper on one row and inside the edge', async ({ app, page }) => {
  const os = [{ os: 'linux', state: 'pass', checks: 4 }, { os: 'macos', state: 'running', checks: 4 }, { os: 'windows', state: 'running', checks: 4 }]
  const cases = [
    { name: 'release-pr', words: /^checks 1 of 3 systems$/,
      stats: statsOf([pr(942, 'chore(release): 0.183.0', 'open'), pr(940, 'feat: a batch', 'merged', 1_800_000)], [{ ...card(942, 'open', 'running'), os }, card(940, 'merged')], [rel('v0.182.4', 86_400_000, 23)]) },
    { name: 'waiting', words: /^Waiting for #941 · ready to merge$/,
      stats: statsOf([pr(941, 'feat: the next batch with a title long enough to fill the line', 'open')], [card(941, 'ready', 'pass')], [rel('v0.182.4', 86_400_000, 23)]), onPR: true },
    // Owner, 2026-11-23: the hint's open PRs as rows, five then +N more;
    // the batch it waits for, #999, is in none of them, so the words link it.
    { name: 'hint-rows', words: /^Waiting for #999 to merge$/, via: 999, onPR: true,
      stats: statsOf(
        Array.from({ length: 7 }, (_, i) => pr(1017 + i, `${i % 3 ? 'fix' : 'feat'}(ui): an open pull request whose title is far too long for the panel ${i}`, 'open')),
        Array.from({ length: 7 }, (_, i) => ({ ...card(1017 + i, 'open', 'running'), os })),
        [rel('v0.182.4', 86_400_000, 23)]) },
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
      x.unreleased = { ref: 'origin/master', items: ['a', 'b', 'c'], count: 3, kinds: { Changed: 1, Fixed: 2 }, ...('onPR' in c ? { via: { number: 'via' in c ? c.via : 941, head: 'feat/batch', sha: 'abc' } } : {}),
        entries: [0, 1, 2].map((i) => ({ text: `Entry ${i}: what changed, written for a person reading the release notes, long enough to wrap onto a second line`, scope: 'ui', kind: i ? 'Fixed' : 'Changed', source: source(i) })) }
    }
    await r.fulfill({ response: res, json: w })
  })
  await page.addInitScript(() => {
    localStorage.setItem('caprock.app.cockpit-looks', JSON.stringify({ ci: 'compact', release: 'full', changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact', tools: 'compact' }))
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
        const steps = strip.querySelector('[data-release-steps]') as HTMLElement
        if (steps.getBoundingClientRect().height > 34) out.push(`the stepper wraps: ${steps.getBoundingClientRect().height}px`)
        for (const word of steps.querySelectorAll<HTMLElement>('[data-strip-word]')) {
          if (word.scrollWidth > word.clientWidth) out.push(`a step's word is cut: ${word.textContent}`)
        }
        const words = strip.querySelector('[data-release-stage-words]') as HTMLElement
        if (words.getBoundingClientRect().height > 34) out.push(`the stage words run past two lines: ${words.textContent}`)
        if (words.parentElement!.scrollWidth > words.parentElement!.clientWidth + 0.5) out.push(`the stage words are cut: ${words.textContent}`)
        for (const line of sec.querySelectorAll<HTMLElement>('[data-release-via], [data-release-section="branch"]')) {
          if (line.getBoundingClientRect().height > 20) out.push(`wraps: ${line.textContent}`)
        }
        // The hint's rows: one line each, the title cut rather than wrapped.
        for (const row of sec.querySelectorAll<HTMLElement>('[data-release-hint-rows] > li')) {
          if (row.getBoundingClientRect().height > 26) out.push(`a hint row wraps: ${row.textContent}`)
          const t = row.querySelector('[data-release-title]') as HTMLElement
          if (t.offsetWidth === 0) out.push(`a hint row lost its title: ${row.textContent}`)
        }
        // Owner, 2026-11-24: the kinds' headings one row each, a chevron
        // first, every count at the same x whatever the word's length.
        const heads = [...sec.querySelectorAll<HTMLElement>('[data-release-kind] > button')]
        if (heads.length !== 2) out.push(`expected 2 kind headings, saw ${heads.length}`)
        for (const h of heads) {
          if (h.getBoundingClientRect().height > 24) out.push(`a kind heading wraps: ${h.textContent}`)
          if (!h.firstElementChild || h.firstElementChild.tagName.toLowerCase() !== 'svg') out.push(`a kind heading has no chevron first: ${h.textContent}`)
        }
        const xs = new Set(heads.map((h) => Math.round(h.querySelector('[data-release-kind-count]')!.getBoundingClientRect().left)))
        if (xs.size !== 1) out.push(`the kinds' counts are not aligned: ${[...xs].join(', ')}`)
        return out
      })
      expect(over, `${k.name} at ${w}px`).toEqual([])
      if (k.name === 'hint-rows') {
        const hint = inspector.locator('section[aria-label="Release"] [data-release-hint]')
        await expect(hint.locator('[data-release-hint-rows] > li')).toHaveCount(5)
        await expect(hint.locator('[data-release-hint-more]')).toHaveText('+2 more')
        await expect(words).toHaveAttribute('href', /pr=999/)
      }
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
  localStorage.setItem('caprock.app.cockpit-looks', JSON.stringify({ ci: 'full', release: 'full', changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact', tools: 'compact' }))
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
  expect(await head.evaluate((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim())).toMatch(/^Next 0\.185\.3 ?· ?patch · fixes only$/)
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
