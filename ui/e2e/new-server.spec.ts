/**
 * New server (ADR-109 P1): Settings → Computers → New server writes the
 * setup script with a server key inside, shows it in full with Copy and
 * where each provider takes it, counts down, and opens the server's page
 * once it has joined. It fits a phone's width without a sideways scroll.
 *
 * The script route and the join are answered at the page: nothing reaches
 * GitHub or a relay, and the shared stand's daemon makes no key.
 */
import { expect, test } from './fixtures'

const SRV = 'srv1000000000000000000000000000000000000000AB'
const SCRIPT = [
  '#!/bin/sh',
  '# Caprock server setup (ADR-109), made by Caprock on the computer you work on.',
  "CAPROCK_VERSION='0.201.0'",
  "CAPROCK_JOIN_KEY='cj1-AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_QEFCQ0RFRkdISUpLTE1OT1BR'",
  'set -eu',
  '',
].join('\n')
const json = (b: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(b) })

for (const width of [1440, 390]) {
  test(`New server at ${width} px: the script in full, then the server's page once it joined`, async ({ app, page }) => {
    test.setTimeout(60_000)
    const now = Date.now()
    const srv = { id: SRV, name: 'hetzner-1', relay: 'wss://relay.invalid', added_at: now, status: 'online', kind: 'machine', role: 'controller', version: '0.201.0', last_seen: now, streams: 0 }
    let machines: unknown[] = []
    let joined = false
    const asked: unknown[] = []

    await page.route(/\/v1\/machines\/server-script$/, (r) => {
      asked.push(r.request().postDataJSON())
      return r.fulfill(json({ state: 'waiting', server: true, expires_at: now + 60 * 60_000, relay: 'wss://relay.caprock.dev', relay_status: 'online', script: SCRIPT, version: '0.201.0', signed: true }))
    })
    await page.route(/\/v1\/machines\/join-key$/, (r) => {
      if (r.request().method() === 'DELETE') return r.fulfill(json({ withdrawn: true }))
      return r.fulfill(json(joined
        ? { state: 'joined', server: true, machine: srv, joiner: 'hetzner-1' }
        : { state: 'waiting', server: true, expires_at: now + 60 * 60_000, relay: 'wss://relay.caprock.dev', relay_status: 'online' }))
    })
    await page.route(/\/v1\/machines(\?.*)?$/, (r) => r.request().method() === 'GET' ? r.fulfill(json({ machines })) : r.fallback())
    await page.route(/\/v1\/machines\/sessions$/, (r) => r.fulfill(json({ machines: machines.length ? [{ id: SRV, name: 'hetzner-1', status: 'online', at: now, sessions: [] }] : [] })))
    await page.route(/\/v1\/machines\/secrets$/, (r) => r.fulfill(json({ secrets: [] })))
    await page.route(/\/v1\/secrets\/received$/, (r) => r.fulfill(json({ arrivals: [] })))
    await page.route(/\/v1\/m\/[^/]+\//, (r) => {
      const p = new URL(r.request().url()).pathname.replace(/^\/v1\/m\/[^/]+/, '')
      if (p === '/v1/sessions') return r.fulfill(json([]))
      if (p === '/v1/setup/runs') return r.fulfill(json({ runs: [] }))
      if (p === '/v1/setup') return r.fulfill(json({ os: 'linux', items: [], agents: [] }))
      if (p === '/v1/resources') return r.fulfill(json({ at: now, sessions: [], machine: { cpus: 8, mem_total: 16 * 2 ** 30, mem_available: 12 * 2 ** 30 } }))
      return r.fulfill(json({ error: 'not in this test' }, 404))
    })
    await page.routeWebSocket(/\/v1\/m\//, () => {})
    await page.setViewportSize({ width, height: 900 })
    await app.open()
    await page.goto(`${new URL(page.url()).origin}/?app=1#/settings/computers`)
    await page.getByRole('radio', { name: /This is where I work/ }).click()

    await page.getByRole('button', { name: 'New server' }).click()
    await page.getByLabel(/I log in with an SSH key/).check()
    await page.getByRole('button', { name: 'Make the script' }).click()
    const panel = page.locator('[data-new-server="waiting"]')
    await expect(panel).toBeVisible()
    expect(asked).toEqual([{ ssh_key: true }])
    await expect(panel.locator('[data-new-server-script]')).toHaveText(SCRIPT)
    await expect(panel.locator('[data-new-server-providers]')).toContainText('Hetzner Cloud: Cloud config')
    await expect(panel.locator('[data-new-server-providers]')).toContainText('DigitalOcean: User data')
    await expect(panel.locator('[data-new-server-left]')).toContainText('60 more min')
    await expect(panel).toContainText('checked by its signature and its SHA-256')
    await expect(panel.getByRole('button', { name: 'Copy script' })).toBeVisible()
    // No sideways scroll: the script scrolls inside its own block.
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(over).toBeLessThanOrEqual(0)

    machines = [srv]
    joined = true
    await expect(page).toHaveURL(new RegExp(`#/m/${SRV}\\?joined=1$`), { timeout: 10_000 })
  })
}
