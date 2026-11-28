/**
 * New server → I already have a server (ADR-109, amended 2026-11-28), the
 * flow a customer's email gives: Address <IP>, user root, ssh asks for the
 * password. The form checks the address; Set up asks the daemon for the
 * command, which opens in a shell tab typed and not run, as the daemon
 * spells it for macOS, Windows and Linux (rule 12's way: each OS's spelling,
 * faked at the page). Back in Settings the wait is still there, and the
 * server's page opens once it joins.
 *
 * The key, script and machine routes are answered at the page: the shared
 * stand's daemon makes no key and writes no script. The shell is the
 * stand's own, real, in a stand session's folder: the command is read back
 * from its terminal, never run, and the shell is stopped at the end.
 */
import { expect, shellIds, stopAgent, test } from './fixtures'

const SRV = 'srv2000000000000000000000000000000000000000CD'
const SPELLINGS: Record<string, string> = {
  darwin: "ssh -p 22 root@203.0.113.7 'sh -s' < '/Users/me/Library/Application Support/caprock/server-scripts/caprock-setup-1.sh'",
  linux: "ssh -p 22 root@203.0.113.7 'sh -s' < '/home/me/.local/share/caprock/server-scripts/caprock-setup-1.sh'",
  windows: 'cmd --% /c ssh -p 22 root@203.0.113.7 "sh -s" < "C:\\Users\\me\\AppData\\Local\\caprock\\server-scripts\\caprock-setup-1.sh"',
}
const json = (b: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(b) })

for (const [os, command] of Object.entries(SPELLINGS)) {
  for (const width of os === 'linux' ? [1440, 390] : [1440]) {
    test(`I already have a server on ${os} at ${width} px: root, the ssh command typed in a tab, then the server`, async ({ app, page, stand }) => {
      test.setTimeout(60_000)
      const now = Date.now()
      const srv = { id: SRV, name: 'my-vps', relay: 'wss://relay.invalid', added_at: now, status: 'online', kind: 'machine', role: 'controller', version: '0.201.0', last_seen: now, streams: 0 }
      let machines: unknown[] = []
      let joined = false
      const asked: unknown[] = []
      const typed: string[] = []
      const home = stand.sessions[0]!.cwd
      await page.route(/\/v1\/machines\/server-ssh$/, (r) => {
        asked.push(r.request().postDataJSON())
        return r.fulfill(json({ state: 'waiting', server: true, expires_at: now + 60 * 60_000, relay: 'wss://relay.caprock.dev', relay_status: 'online', command, os, home, version: '0.201.0', signed: true }))
      })
      await page.route(/\/v1\/machines\/join-key$/, (r) => r.request().method() === 'DELETE'
        ? r.fulfill(json({ withdrawn: true }))
        : r.fulfill(json(joined
          ? { state: 'joined', server: true, machine: srv, joiner: 'my-vps' }
          : { state: 'waiting', server: true, expires_at: now + 60 * 60_000, relay_status: 'online' })))
      // This page's tab strip (only the setup shell, soon stopped) must not
      // become the stand's latest report: the phone home's Continue mirrors
      // it (GET /v1/tabs), and a later spec found no row to open a menu on.
      await page.route(/\/v1\/tabs$/, (r) => r.request().method() === 'PUT' ? r.fulfill({ status: 204 }) : r.fallback())
      await page.route(/\/v1\/shells$/, (r) => {
        if (r.request().method() === 'POST') typed.push((r.request().postDataJSON() as { type?: string }).type ?? '')
        return r.fallback()
      })
      await page.route(/\/v1\/machines(\?.*)?$/, (r) => r.request().method() === 'GET' ? r.fulfill(json({ machines })) : r.fallback())
      await page.route(/\/v1\/machines\/sessions$/, (r) => r.fulfill(json({ machines: machines.length ? [{ id: SRV, name: 'my-vps', status: 'online', at: now, sessions: [] }] : [] })))
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
      const before = new Set(await shellIds(stand.daemonURL))
      await page.setViewportSize({ width, height: 900 })
      try {
        await app.open()
        await page.goto(`${new URL(page.url()).origin}/?app=1#/settings/computers`)
        await page.getByRole('radio', { name: /This is where I work/ }).click()

        await page.getByRole('button', { name: 'New server' }).click()
        await page.getByLabel('I already have a server').check()
        const form = page.locator('[data-own-server="form"]')
        await expect(form.locator('[data-own-server-user]')).toHaveValue('root')
        await expect(form).toContainText('turns password login off')

        // An address a shell would read as two commands is refused here.
        await form.locator('[data-own-server-address]').fill('203.0.113.7; reboot')
        await expect(form.getByRole('alert')).toContainText('The address is')
        await expect(form.getByRole('button', { name: 'Set up' })).toBeDisabled()

        await form.locator('[data-own-server-address]').fill('203.0.113.7')
        await form.getByRole('button', { name: 'Set up' }).click()
        await expect.poll(() => asked).toEqual([{ address: '203.0.113.7', user: 'root' }])

        // The command, as it is, in a shell tab here: typed, not run.
        await expect.poll(() => typed).toEqual([command])
        await expect.poll(async () => (await shellIds(stand.daemonURL)).filter((id) => !before.has(id)).length).toBe(1)
        const sh = (await shellIds(stand.daemonURL)).find((id) => !before.has(id))!
        // Read from the terminal where one is drawn: a phone's width shows
        // the tab without the terminal's rows in this page.
        if (width > 600) await app.waitTerm(sh, 'root@203.0.113.7')

        // Back in Settings, in the same page: the wait is still there.
        await page.evaluate(() => { window.location.hash = '#/settings/computers' })
        const panel = page.locator('[data-own-server="waiting"]')
        await expect(panel).toBeVisible()
        await expect(panel).toContainText(command)
        await expect(panel.locator('[data-own-server-ssh]')).toContainText('password')
        await expect(panel.locator('[data-own-server-after]')).toContainText('password login to this server is off')
        await expect(panel.locator('[data-own-server-left]')).toContainText('60 more min')
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        expect(over).toBeLessThanOrEqual(0)

        machines = [srv]
        joined = true
        await expect(page).toHaveURL(new RegExp(`#/m/${SRV}\\?joined=1$`), { timeout: 10_000 })
      } finally {
        for (const id of await shellIds(stand.daemonURL)) if (!before.has(id)) await stopAgent(stand.daemonURL, id)
      }
    })
  }
}
