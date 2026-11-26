/**
 * The folder access strip (lib/termprivacy.ts, ADR-106), against the
 * sandboxed stand: a session whose terminal shows macOS refusing Downloads
 * gets a line naming the folder and the System Settings entry, and *Open
 * Settings* asks the daemon to open the pane. The strip is for a daemon on
 * macOS only: the stand may run on Linux (CI), so the page is told the
 * daemon's platform is macOS. Both privacy routes are answered by the page
 * route here, never by the daemon: on a Mac the open route would raise
 * System Settings, and no test may open an OS window.
 */
import { expect, stopAgent, test } from './fixtures'

test('a refused Downloads read names the switch and opens the pane on a click', async ({ app, page, stand }) => {
  const cwd = stand.sessions[0]!.cwd
  const post = (p: string, body: unknown) => fetch(`${stand.daemonURL}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const r = await post('/v1/agents', { cwd })
  const { session_id: id } = await r.json() as { session_id: string }
  expect(r.ok).toBe(true)
  const name = 'e2e privacy'
  await fetch(`${stand.daemonURL}/v1/sessions/${id}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
  await page.route(/\/v1\/status$/, async (route) => {
    const res = await route.fetch()
    const body = await res.json() as Record<string, unknown>
    await route.fulfill({ response: res, json: { ...body, platform: 'darwin/arm64' } })
  })
  const opened: string[] = []
  await page.route(/\/v1\/sessions\/[^/]+\/privacy(\/open)?$/, async (route) => {
    if (route.request().method() === 'POST') opened.push(route.request().postData() ?? '')
    await route.fulfill({ json: { name: 'Caprock Terminal', live: true } })
  })
  try {
    await app.open()
    await app.row(name).first().click()
    await app.waitTerm(id, 'fake-claude ready')
    const strip = page.locator('[data-privacy-strip]')
    await expect(strip).toHaveCount(0)
    expect((await post(`/v1/agents/${id}/input`, { data: 'eperm-downloads\r' })).status).toBe(204)
    await expect(strip).toBeVisible()
    await expect(strip).toContainText('macOS kept this session out of Downloads.')
    await expect(strip).toContainText('Allow Caprock Terminal in System Settings')
    expect(opened).toEqual([])
    await strip.getByRole('button', { name: 'Open Settings' }).click()
    await expect(strip).toContainText('Switch on Caprock Terminal in the list, then try again.')
    expect(opened).toEqual([JSON.stringify({ pane: 'full_disk' })])
    await strip.getByRole('button', { name: 'Dismiss — folder access' }).click()
    await expect(strip).toHaveCount(0)
  } finally {
    await page.close()
    await stopAgent(stand.daemonURL, id)
  }
})
