/**
 * Bypass on another computer (#1086): the owner's first two starts in Bypass
 * on a linked Windows PC ended about 8 s later on Claude Code's own one-time
 * warning, and New agent showed nothing. Now the sheet asks that computer
 * first: opened on it, Bypass picked, the warning and *Accept and start* are
 * there before any start; Accept records the consent there, then starts.
 * The computer is answered at the page: nothing reaches a relay, and no
 * session is started (the start is answered too).
 *
 * With CAPROCK_SHOTS_DIR set it photographs the sheet.
 */
import path from 'node:path'
import { expect, test } from './fixtures'

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''
const WIN = 'winPC1000000000000000000000000000000000000AB'
const json = (b: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(b) })

test('New agent on another computer shows its bypass warning on the first try, and accepts it there', async ({ app, page }) => {
  const now = Date.now()
  const machines = [{ id: WIN, name: 'Win PC1', relay: 'wss://relay.invalid', added_at: now, status: 'online', kind: 'machine', role: 'controller', version: '0.198.0', last_seen: now, streams: 0 }]
  const asked: string[] = []
  await page.route(/\/v1\/machines(\?.*)?$/, (r) => r.request().method() === 'GET' ? r.fulfill(json({ machines })) : r.fallback())
  await page.route(/\/v1\/machines\/sessions$/, (r) => r.fulfill(json({ machines: [{ id: WIN, name: 'Win PC1', status: 'online', at: now, sessions: [] }] })))
  await page.route(/\/v1\/m\/[^/]+\//, (r) => {
    const u = new URL(r.request().url())
    const p = u.pathname.replace(/^\/v1\/m\/[^/]+/, '')
    const method = r.request().method()
    asked.push(`${method} ${p}`)
    if (p === '/v1/status') return r.fulfill(json({ version: '0.198.0', claude_bypass_accepted: false }))
    if (p === '/v1/projects') return r.fulfill(json({ projects: [{ id: 1, root: 'C:\\Users\\me\\dev\\api', name: 'api', kind: 'repo' }] }))
    if (p === '/v1/recent-dirs') return r.fulfill(json([]))
    if (p === '/v1/agents/catalog') return r.fulfill(json({ licensed: true, home: 'C:\\Users\\me', agents: [{ id: 'claude', label: 'Claude Code', installed: true, ready: true, models: [], observed: true, prompt: true }] }))
    if (p === '/v1/browse/stat') return r.fulfill(json({ path: 'C:\\Users\\me\\dev\\api', exists: true, is_dir: true }))
    if (p === '/v1/browse') return r.fulfill(json({ root: 'C:\\Users\\me', dir: 'C:\\Users\\me\\dev', parent: 'C:\\Users\\me', entries: [] }))
    if (p === '/v1/claude/bypass-consent' && method === 'POST') return r.fulfill(json({ accepted: true }))
    if (p === '/v1/agents' && method === 'POST') return r.fulfill(json({ session_id: 'far-1', cwd: 'C:\\Users\\me\\dev\\api' }))
    if (/^\/v1\/agents\/[^/]+\/exit$/.test(p)) return r.fulfill(json({ error: 'the session is still running' }, 409))
    if (p === '/v1/setup') return r.fulfill(json({ os: 'windows', items: [{ key: 'agent', state: 'ok', label: 'Agents', detail: '' }], agents: [{ id: 'claude', label: 'Claude Code', on: true, state: 'ok', detail: '' }] }))
    if (p === '/v1/resources') return r.fulfill(json({ at: now, sessions: [], machine: { cpus: 16, mem_total: 32 * 2 ** 30, mem_available: 18 * 2 ** 30 } }))
    if (p === '/v1/sessions') return r.fulfill(json([]))
    // Anything else the stand's own daemon answers.
    u.pathname = p
    return r.continue({ url: u.toString() })
  })
  await app.open()

  await page.locator(`[data-machine-rows] [data-machine-row="${WIN}"] button`).first().click()
  await page.getByRole('button', { name: 'Start an agent there' }).click()
  const sheet = page.getByRole('dialog', { name: 'New agent' })
  await expect(sheet.getByRole('combobox', { name: 'Machine', exact: true })).toHaveValue(WIN)
  await expect(sheet.getByRole('textbox', { name: 'Folder on Win PC1' })).toHaveValue('C:\\Users\\me\\dev\\api')
  await sheet.getByRole('radio', { name: /Bypass/ }).click()
  // Before any start: the warning, and the button that answers it.
  const note = sheet.getByRole('note', { name: 'Bypass consent' })
  await expect(note).toContainText('First bypass session on Win PC1')
  await expect(sheet.getByRole('button', { name: /Accept and start/ })).toBeVisible()
  expect(asked.filter((a) => a === 'POST /v1/agents')).toEqual([])
  if (shotsDir) {
    await page.waitForTimeout(150)
    await page.screenshot({ path: path.join(shotsDir, 'remote-bypass.png') })
  }

  await sheet.getByRole('button', { name: /Accept and start/ }).click()
  await expect(sheet).toHaveCount(0)
  const consent = asked.indexOf('POST /v1/claude/bypass-consent')
  expect(consent).toBeGreaterThan(-1)
  expect(asked.indexOf('POST /v1/agents')).toBeGreaterThan(consent)
})
