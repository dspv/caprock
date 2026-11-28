/**
 * Talks (ADR-110), two people end to end, with the friction counted.
 *
 * Dima and Ana each have a Caprock (talks-stand.ts: two sandboxed daemons, a
 * loopback relay, the fake claude). Through their dashboards only:
 *
 * - a new pair: Dima invites, Ana pastes the link and accepts, Dima starts a
 *   Talk — at most five actions to his agent's first message;
 * - Ana's never-share term in his opening holds her agent's answer: the hold
 *   card, Send, and it leaves with the term taken out;
 * - Dima types in, Ana sees it as his; What left this machine lists it;
 * - a linked pair: a second Talk in at most two actions;
 * - the phone width draws the same Talk; Settings → Talks is there.
 *
 * An action is one click or one Enter, with the text it sends typed before
 * it (the goal, the pasted link). With CAPROCK_SHOTS_DIR set it photographs
 * each screen at 1440 and 390.
 */
import path from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { startPair, type Pair, type Side } from './talks-stand'

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''

let pair: Pair
test.beforeAll(async () => {
  test.setTimeout(120_000)
  pair = await startPair()
  for (const [s, body] of [[pair.dima, { name: 'Dima', max_messages: 3 }], [pair.ana, { name: 'Ana', max_messages: 3, never_share: ['Pelican'] }]] as const) {
    const r = await fetch(`${s.daemonURL}/v1/talks/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect(r.ok, await r.text()).toBe(true)
  }
})
test.afterAll(async () => { await pair?.stop() })

/** A page on one side that fails the test on a console error, an exception, or a request off both stands. */
async function open(browser: Browser, side: Side, width = 1440): Promise<{ ctx: BrowserContext; page: Page; problems: string[] }> {
  const ctx = await browser.newContext({ viewport: { width, height: width > 500 ? 900 : 844 }, ...(width <= 500 ? { isMobile: true, hasTouch: true } : {}) })
  const page = await ctx.newPage()
  const problems: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${side.name} console.error: ${m.text()} (${m.location().url})`) })
  page.on('pageerror', (e) => problems.push(`${side.name} uncaught: ${e.message}`))
  page.on('request', (r) => {
    const u = r.url()
    if (!u.startsWith(side.pageURL) && !u.startsWith(side.pageURL.replace('http', 'ws')) && !/^(data|blob):/.test(u)) problems.push(`${side.name} request off the stand: ${u}`)
  })
  return { ctx, page, problems }
}

async function shoot(page: Page, name: string) {
  if (!shotsDir) return
  const w = page.viewportSize()?.width ?? 0
  for (const theme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await page.waitForTimeout(150)
    await page.screenshot({ path: path.join(shotsDir, `talks-${name}-${w}-${theme}.png`) })
  }
}

test('two people: linked in five actions, a Talk in two, a hold answered, what left listed', async ({ browser }) => {
  test.setTimeout(150_000)
  const d = await open(browser, pair.dima)
  const a = await open(browser, pair.ana)
  let actions = 0
  const act = async (fn: () => Promise<void>) => { actions++; await fn() }
  try {
    await d.page.goto(`${pair.dima.pageURL}/#/talks`)
    await a.page.goto(`${pair.ana.pageURL}/#/talks`)
    await expect(d.page.getByRole('heading', { name: 'Talks', exact: true })).toBeVisible()
    await shoot(d.page, 'empty')

    // --- a new pair: at most five actions to the first agent message
    await act(() => d.page.locator('[data-talk-invite]').click())
    const link = (await d.page.locator('[data-talk-link]').textContent())?.trim() ?? ''
    expect(link).toMatch(/^https:\/\/caprock\.dev\/talk#cj1-/)
    await shoot(d.page, 'invite')
    await a.page.locator('[data-talk-paste]').fill(link)
    await act(() => a.page.locator('[data-talk-accept]').click())
    await expect(a.page.locator('[data-talk-linked]')).toContainText('Dima and you are linked')
    await expect(a.page.locator('[data-person="Dima"]')).toBeVisible()
    await expect(d.page.locator('[data-person="Ana"]')).toBeVisible({ timeout: 15_000 })
    // The same twelve digits on both sides.
    const codeD = await d.page.locator('[data-person="Ana"] [data-safety-code]').textContent()
    const codeA = await a.page.locator('[data-person="Dima"] [data-safety-code]').textContent()
    expect(codeD).toMatch(/^\d{4} \d{4} \d{4}$/)
    expect(codeA).toBe(codeD)
    await act(() => d.page.locator('[data-talk-with="Ana"]').click())
    await d.page.locator('[data-talk-goal]').fill('Find a time for the Pelican launch call')
    await act(() => d.page.locator('[data-talk-goal]').press('Enter'))
    await expect(d.page.locator('[data-voice="mine"]').first()).toContainText('Opening: Find a time for the Pelican launch call', { timeout: 20_000 })
    expect(actions, 'actions for a new pair to the first agent message').toBeLessThanOrEqual(5)
    const firstTalk = new URL(d.page.url()).hash.replace('#/talks/', '')

    // --- Ana: her agent's answer quotes "Pelican", on her never-share list: held
    await a.page.goto(`${pair.ana.pageURL}/#/talks/${firstTalk}`)
    await expect(a.page.locator('[data-hold="redaction"]')).toBeVisible({ timeout: 20_000 })
    await expect(a.page.locator('[data-held-text]')).not.toContainText('Pelican')
    await expect(a.page.locator('[data-voice="theirs"]').first()).toContainText('Opening:')
    await shoot(a.page, 'hold')
    await a.page.locator('[data-hold-send]').click()
    await expect(a.page.locator('[data-hold]')).toHaveCount(0, { timeout: 10_000 })
    await expect(d.page.locator('[data-voice="theirs"]').first()).toBeVisible({ timeout: 20_000 })
    await expect(d.page.locator('[data-voice="theirs"]').first()).not.toContainText('Pelican')

    // --- Dima types in; Ana reads it as his
    await d.page.locator('[data-talk-say]').fill('Thursday after 3pm works for me.')
    await d.page.locator('[data-talk-say]').press('Enter')
    await expect(d.page.locator('[data-voice="me"]')).toContainText('Thursday after 3pm')
    await expect(a.page.locator('[data-voice="partner"]')).toContainText('Thursday after 3pm', { timeout: 20_000 })
    await expect(a.page.locator('[data-voice="partner"]').getByText('Dima', { exact: true })).toBeVisible()
    await shoot(d.page, 'talk')
    await shoot(a.page, 'talk-ana')

    // --- What left this machine: his opening and his typed line, word for word
    await d.page.locator('[data-talk-log-open]').click()
    const log = d.page.locator('[data-talk-log]')
    await expect(log).toContainText('Opening: Find a time for the Pelican launch call')
    await expect(log).toContainText('typed by you')
    await expect(log).toContainText('Thursday after 3pm works for me.')
    await shoot(d.page, 'left')
    await d.page.keyboard.press('Escape')

    // --- a linked pair: a second Talk in at most two actions
    await d.page.goto(`${pair.dima.pageURL}/#/talks`)
    await expect(d.page.locator('[data-person="Ana"]')).toBeVisible()
    actions = 0
    await act(() => d.page.locator('[data-talk-with="Ana"]').click())
    await d.page.locator('[data-talk-goal]').fill('Swap notes on the onboarding draft')
    await act(() => d.page.locator('[data-talk-goal]').press('Enter'))
    await expect(d.page.locator('[data-voice="mine"]').first()).toContainText('Opening: Swap notes', { timeout: 20_000 })
    expect(actions, 'actions for a linked pair to the first agent message').toBeLessThanOrEqual(2)

    // The list, each side; Settings → Talks.
    await d.page.goto(`${pair.dima.pageURL}/#/talks`)
    await expect(d.page.locator('[data-talk-row]')).toHaveCount(2)
    await shoot(d.page, 'list')
    await d.page.goto(`${pair.dima.pageURL}/#/settings`)
    const sec = d.page.locator('[data-talks-never]')
    await sec.scrollIntoViewIfNeeded()
    await sec.fill('Orion')
    await d.page.locator('[data-talks-save]').click()
    await expect(d.page.getByText('Saved. The never-share list applies at once')).toBeVisible()
    await d.page.locator('[data-talks-name]').scrollIntoViewIfNeeded()
    await shoot(d.page, 'settings')

    // --- the phone's width: the same Talk, the list
    const p = await open(browser, pair.ana, 390)
    try {
      await p.page.goto(`${pair.ana.pageURL}/#/talks/${firstTalk}`)
      await expect(p.page.locator('[data-voice="partner"]')).toContainText('Thursday after 3pm')
      const overflow = await p.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow, 'no sideways scroll at 390').toBeLessThanOrEqual(0)
      await shoot(p.page, 'talk-phone')
      await p.page.goto(`${pair.ana.pageURL}/#/talks`)
      await expect(p.page.locator('[data-person="Dima"]')).toBeVisible()
      await shoot(p.page, 'list-phone')
      expect(p.problems).toEqual([])
    } finally { await p.ctx.close() }

    // --- Remove: both sides lose the person, the Talks end
    await d.page.goto(`${pair.dima.pageURL}/#/talks`)
    await d.page.locator('[data-person="Ana"]').getByRole('button', { name: 'Remove', exact: true }).click()
    await d.page.locator('[data-person="Ana"]').getByRole('button', { name: /Remove Ana on both sides/ }).click()
    await expect(d.page.locator('[data-person="Ana"]')).toHaveCount(0)
    await expect(a.page.locator('[data-person="Dima"]')).toHaveCount(0, { timeout: 20_000 }).catch(async () => {
      await a.page.goto(`${pair.ana.pageURL}/#/talks`)
      await expect(a.page.locator('[data-person="Dima"]')).toHaveCount(0, { timeout: 20_000 })
    })
    expect([...d.problems, ...a.problems]).toEqual([])
  } finally {
    await d.ctx.close()
    await a.ctx.close()
  }
})
