/**
 * Send secrets to a linked computer (ADR-107, issue #1095): the Windows PC's
 * page offers the keys this computer keeps, none ticked; a key not set here
 * cannot be ticked; Send goes on the click only, with the names alone, and
 * the page says what the PC kept. Its Settings → Computers names what
 * arrived under the computer that sent it.
 *
 * Both computers are answered at the page: nothing reaches a relay or a
 * store, and the shared stand's settings are never written.
 *
 * With CAPROCK_SHOTS_DIR set it photographs the card, light and dark.
 */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''

async function shoot(page: Page, name: string) {
  if (!shotsDir) return
  for (const theme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await page.waitForTimeout(150)
    await page.screenshot({ path: path.join(shotsDir, `send-secrets-${name}-${theme}.png`) })
  }
}

const WIN = 'winPC1000000000000000000000000000000000000AB'
const json = (b: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(b) })

test('Keys go to a linked computer on Send only, by name', async ({ app, page }) => {
  test.setTimeout(60_000)
  const now = Date.now()
  const machines = [{ id: WIN, name: 'Win PC1', relay: 'wss://relay.invalid', added_at: now, status: 'online', kind: 'machine', role: 'controller', version: '0.199.0', last_seen: now, streams: 0 }]
  const sent: unknown[] = []

  await page.route(/\/v1\/machines(\?.*)?$/, (r) => r.request().method() === 'GET' ? r.fulfill(json({ machines })) : r.fallback())
  await page.route(/\/v1\/machines\/sessions$/, (r) => r.fulfill(json({ machines: [{ id: WIN, name: 'Win PC1', status: 'online', at: now, sessions: [] }] })))
  await page.route(/\/v1\/machines\/secrets$/, (r) => r.fulfill(json({
    secrets: [
      { name: 'github', label: 'GitHub token', set: false, note: 'GitHub is connected through the GitHub CLI\'s sign-in here, which Caprock does not hold' },
      { name: 'deepseek', label: 'DeepSeek key', set: true },
      { name: 'kimi', label: 'Kimi key', set: true },
    ],
  })))
  await page.route(new RegExp(`/v1/machines/${WIN}/secrets$`), (r) => {
    sent.push(r.request().postDataJSON())
    return r.fulfill(json({ stored: ['deepseek', 'kimi'], failed: [] }))
  })
  await page.route(/\/v1\/secrets\/received$/, (r) => r.fulfill(json({ arrivals: [] })))
  // The PC's own reads: ready, a checklist from before its tools, no sessions.
  await page.route(/\/v1\/m\/[^/]+\//, (r) => {
    const p = new URL(r.request().url()).pathname.replace(/^\/v1\/m\/[^/]+/, '')
    if (p === '/v1/sessions') return r.fulfill(json([]))
    if (p === '/v1/setup/runs') return r.fulfill(json({ runs: [] }))
    if (p === '/v1/setup') {
      return r.fulfill(json({
        os: 'windows',
        items: [
          { key: 'git', state: 'ok', label: 'Git', detail: 'Installed.' },
          { key: 'agent', state: 'ok', label: 'Agents', detail: 'Claude Code ready.' },
        ],
        agents: [{ id: 'claude', label: 'Claude Code', on: true, state: 'ok', detail: 'Signed in. Ready.' }],
      }))
    }
    if (p === '/v1/resources') return r.fulfill(json({ at: now, sessions: [], machine: { cpus: 16, mem_total: 32 * 2 ** 30, mem_available: 18 * 2 ** 30 } }))
    return r.fulfill(json({ error: 'not in this test' }, 404))
  })
  await page.routeWebSocket(/\/v1\/m\//, () => {})
  await page.setViewportSize({ width: 1440, height: 900 })
  await app.open()
  await page.locator(`[data-machine-rows] [data-machine-row="${WIN}"] button`).first().click()

  const card = page.getByRole('region', { name: 'Send secrets' })
  await expect(card).toBeVisible()
  const github = card.getByRole('checkbox', { name: /GitHub token/ })
  await expect(github).toBeDisabled()
  await expect(card).toContainText('which Caprock does not hold')
  const ds = card.getByRole('checkbox', { name: /DeepSeek key/ })
  const kimi = card.getByRole('checkbox', { name: /Kimi key/ })
  await expect(ds).not.toBeChecked()
  await expect(card.getByRole('button', { name: 'Send' })).toBeDisabled()
  expect(sent).toEqual([])

  await ds.check()
  await kimi.check()
  await shoot(page, 'ticked')
  await card.getByRole('button', { name: 'Send 2 to Win PC1' }).click()
  await expect(card.getByRole('status')).toHaveText('✓ Win PC1 keeps the DeepSeek key and Kimi key now.')
  expect(sent).toEqual([{ names: ['deepseek', 'kimi'] }])
  await expect(ds).not.toBeChecked()
  await shoot(page, 'sent')
})
