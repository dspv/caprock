/**
 * A new computer joins with one key (ADR-108, issue #1095), both ends.
 *
 * - Where the user works: Settings → Computers → Add with a key shows the
 *   key once, `caprock join <key>`, where to paste it in the app there and
 *   the install commands; when the new computer has joined, its page opens
 *   saying so, with its remaining steps and Send secrets waiting for clicks,
 *   and nothing was run or sent.
 * - On the new computer: Join with a key in the checklist's link item.
 *
 * The join routes and the joined computer are answered at the page: nothing
 * reaches a relay, and the shared stand's daemon makes no key.
 *
 * With CAPROCK_SHOTS_DIR set it photographs the key and the joined page.
 */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''
const WIN = 'winPC1000000000000000000000000000000000000AB'
const KEY = 'cj1-AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_QEFCQ0RFRkdISUpLTE1OT1BR'
const json = (b: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(b) })

async function shoot(page: Page, name: string) {
  if (!shotsDir) return
  for (const theme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await page.waitForTimeout(150)
    await page.screenshot({ path: path.join(shotsDir, `join-key-${name}-${theme}.png`) })
  }
}

test('Add with a key: the key once, then the joined computer opens with its steps offered', async ({ app, page }) => {
  test.setTimeout(60_000)
  const now = Date.now()
  const pc = { id: WIN, name: 'Win PC1', relay: 'wss://relay.invalid', added_at: now, status: 'online', kind: 'machine', role: 'controller', version: '0.200.0', last_seen: now, streams: 0 }
  let machines: unknown[] = []
  let joined = false
  const ran: string[] = []

  await page.route(/\/v1\/machines\/join-key$/, (r) => {
    const m = r.request().method()
    if (m === 'POST') return r.fulfill(json({ state: 'waiting', expires_at: now + 15 * 60_000, relay: 'wss://relay.caprock.dev', relay_status: 'online', key: KEY }))
    if (m === 'DELETE') return r.fulfill(json({ withdrawn: true }))
    return r.fulfill(json(joined
      ? { state: 'joined', machine: pc, joiner: 'Win PC1' }
      : { state: 'waiting', expires_at: now + 15 * 60_000, relay: 'wss://relay.caprock.dev', relay_status: 'online' }))
  })
  await page.route(/\/v1\/machines(\?.*)?$/, (r) => r.request().method() === 'GET' ? r.fulfill(json({ machines })) : r.fallback())
  await page.route(/\/v1\/machines\/sessions$/, (r) => r.fulfill(json({ machines: machines.length ? [{ id: WIN, name: 'Win PC1', status: 'online', at: now, sessions: [] }] : [] })))
  await page.route(/\/v1\/machines\/secrets$/, (r) => r.fulfill(json({ secrets: [{ name: 'deepseek', label: 'DeepSeek key', set: true }] })))
  await page.route(/\/v1\/secrets\/received$/, (r) => r.fulfill(json({ arrivals: [] })))
  await page.route(/\/v1\/m\/[^/]+\//, (r) => {
    const p = new URL(r.request().url()).pathname.replace(/^\/v1\/m\/[^/]+/, '')
    if (r.request().method() !== 'GET') ran.push(p)
    if (p === '/v1/sessions') return r.fulfill(json([]))
    if (p === '/v1/setup/runs') return r.fulfill(json({ runs: [] }))
    if (p === '/v1/setup') {
      return r.fulfill(json({
        os: 'windows',
        items: [
          { key: 'git', state: 'missing', label: 'Git', detail: 'Claude Code on Windows needs Git.', command: 'winget install --id Git.Git -e --source winget' },
          { key: 'agent', state: 'missing', label: 'Agents', detail: 'Claude Code is not installed.' },
        ],
        agents: [{ id: 'claude', label: 'Claude Code', on: true, state: 'missing', detail: 'Not installed.', command: 'irm https://claude.ai/install.ps1 | iex' }],
      }))
    }
    if (p === '/v1/resources') return r.fulfill(json({ at: now, sessions: [], machine: { cpus: 16, mem_total: 32 * 2 ** 30, mem_available: 18 * 2 ** 30 } }))
    return r.fulfill(json({ error: 'not in this test' }, 404))
  })
  await page.routeWebSocket(/\/v1\/m\//, () => {})
  await page.setViewportSize({ width: 1440, height: 900 })
  await app.open()
  await page.goto(`${new URL(page.url()).origin}/?app=1#/settings/computers`)
  await page.getByRole('radio', { name: /This is where I work/ }).click()

  await page.getByRole('button', { name: 'Add with a key' }).click()
  const panel = page.locator('[data-join-key="waiting"]')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('button', { name: `$ caprock join ${KEY}` })).toBeVisible()
  await expect(panel.locator('[data-join-key-value]')).toHaveText(KEY)
  await expect(panel.locator('[data-join-install]')).toContainText('irm https://caprock.dev/win.ps1 | iex')
  await expect(panel).toContainText('Join with a key')
  await expect(panel.locator('[data-join-key-line]')).toHaveText('Waiting for the new computer…')
  await expect(panel.locator('[data-join-key-safe]')).toContainText('relay.caprock.dev')
  await shoot(page, 'shown')

  // The new computer joins: this page opens its page, says so, offers.
  machines = [pc]
  joined = true
  await expect(page).toHaveURL(new RegExp(`#/m/${WIN}\\?joined=1$`), { timeout: 10_000 })
  const note = page.locator('[data-machine-joined]')
  await expect(note).toContainText('Win PC1 joined with the key.')
  await expect(note).toContainText('Nothing has run there and nothing was sent')
  await expect(page.getByRole('region', { name: 'Set up this computer' })).toBeVisible()
  const secrets = page.getByRole('region', { name: 'Send secrets' })
  await expect(secrets).toBeVisible()
  await expect(secrets.getByRole('checkbox', { name: /DeepSeek key/ })).not.toBeChecked()
  await shoot(page, 'joined')
  // Offered, not done: no step ran there and nothing was sent.
  await page.waitForTimeout(1000)
  expect(ran).toEqual([])
  await note.getByRole('link', { name: 'Dismiss' }).click()
  await expect(note).toBeHidden()
})

test('Join with a key on the new computer says what it did and what is next', async ({ app, page }) => {
  test.setTimeout(60_000)
  const asked: unknown[] = []
  await page.route(/\/v1\/join$/, (r) => {
    asked.push(r.request().postDataJSON())
    return r.fulfill(json({ controller: 'x', controller_name: 'MacBook', status: 'online', name: 'Win PC1', turned_on_remote: true, relay: 'wss://relay.caprock.dev' }))
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await app.open()
  await page.goto(`${new URL(page.url()).origin}/?app=1#/settings/computers`)
  await page.getByRole('radio', { name: /Run agents for another computer/ }).click()
  const field = page.getByLabel(/Join with a key/)
  await expect(field).toBeVisible()
  await field.fill(`caprock join ${KEY}`)
  await page.getByRole('button', { name: 'Join', exact: true }).click()
  const done = page.locator('[data-joined]')
  await expect(done).toContainText('MacBook can now start and watch agents on this computer')
  await expect(done).toContainText('Access from anywhere is on now, through relay.caprock.dev')
  expect(asked).toEqual([{ key: `caprock join ${KEY}` }])
})
