/**
 * Computers, as the owner picked them on 2026-11-25 (list A + page B + All
 * computers): the sidebar's two-line rows with a count badge and All N, a
 * computer's page with its memory and processor bars — *No figure* on
 * Windows, which gives no load — and its offline state, and All computers'
 * cards. Three computers answered at the page: nothing reaches a relay.
 *
 * With CAPROCK_SHOTS_DIR set it photographs each view.
 */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''
const GiB = 2 ** 30
const MAC = 'macbookPro0000000000000000000000000000000AB'
const WIN = 'winPC1000000000000000000000000000000000000AB'
const MINI = 'officeMini000000000000000000000000000000000AB'

const json = (b: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(b) })
const session = (id: string, title: string) => ({ session_id: id, title, cwd: '/Users/me/caprock', project: 'caprock', status: 'active', last_event_at: Date.now() - 60_000 })
const setup = (os: string) => ({
  os,
  items: [
    { key: 'agent', state: 'ok', label: 'Agents', detail: '' },
    { key: 'project', state: 'ok', label: 'Projects', detail: '4 projects.', optional: true },
  ],
  agents: [{ id: 'claude', label: 'Claude Code', on: true, state: 'ok', detail: '' }],
})

async function answerComputers(page: Page) {
  const now = Date.now()
  const machines = [
    { id: WIN, name: 'Win PC1', relay: 'wss://relay.invalid', added_at: now, status: 'online', kind: 'machine', role: 'controller', version: '0.191.0', last_seen: now, streams: 0 },
    { id: MAC, name: 'MacBook Pro', relay: 'wss://relay.invalid', added_at: now, status: 'online', kind: 'machine', role: 'controller', version: '0.196.0', last_seen: now, streams: 0 },
    { id: MINI, name: 'Office Mac mini', relay: 'wss://relay.invalid', added_at: now, status: 'offline', kind: 'machine', role: 'controller', version: '0.188.2', last_seen: now - 3 * 86_400_000, streams: 0 },
  ]
  const macRunning = [session('s1', 'Make the video tile show only its first frame'), session('s2', 'Pricing page: the yearly plan first')]
  await page.route(/\/v1\/machines(\?.*)?$/, (r) => r.request().method() === 'GET' ? r.fulfill(json({ machines })) : r.fallback())
  await page.route(/\/v1\/machines\/sessions$/, (r) => r.fulfill(json({ machines: [
    { id: WIN, name: 'Win PC1', status: 'online', at: now, sessions: [] },
    { id: MAC, name: 'MacBook Pro', status: 'online', at: now, sessions: macRunning },
    { id: MINI, name: 'Office Mac mini', status: 'offline', error: 'the computer is offline' },
  ] })))
  await page.route(/\/v1\/m\/[^/]+\//, (r) => {
    const url = r.request().url()
    // The offline one: its sessions read answers nothing new (the list already says offline);
    // its setup and resources are never asked while it is down.
    if (url.includes(`/v1/m/${MINI}/`)) return /\/v1\/sessions$/.test(new URL(url).pathname) ? r.fulfill(json([])) : r.fulfill(json({ error: 'the computer is offline', status: 'offline' }, 503))
    const win = url.includes(`/v1/m/${WIN}/`)
    if (/\/v1\/setup$/.test(new URL(url).pathname)) return r.fulfill(json(setup(win ? 'windows' : 'darwin')))
    if (/\/v1\/resources$/.test(new URL(url).pathname)) {
      return r.fulfill(json({ at: now, sessions: [], machine: win
        ? { cpus: 16, mem_total: 32 * GiB, mem_available: 18.9 * GiB }
        : { cpus: 12, load1: 5.2, mem_total: 36 * GiB, mem_available: 7.9 * GiB } }))
    }
    if (/\/v1\/sessions$/.test(new URL(url).pathname)) return r.fulfill(json(win ? [] : macRunning))
    // Anything else New agent asks of it (recent folders, the agent catalog) the stand's own daemon answers.
    const u = new URL(url)
    u.pathname = u.pathname.replace(/^\/v1\/m\/[^/]+/, '')
    return r.continue({ url: u.toString() })
  })
}

async function shoot(page: Page, name: string) {
  if (!shotsDir) return
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await page.waitForTimeout(120)
    await page.screenshot({ path: path.join(shotsDir, `computers-${name}-${theme}.png`) })
  }
}

test('Computers: sidebar rows, All computers, a machine page with its meters, Windows and offline', async ({ app, page }) => {
  test.setTimeout(90_000)
  await answerComputers(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await app.open()

  // The sidebar: two lines each, the count badge, All 3.
  const rows = page.locator('[data-machine-rows]')
  await expect(rows.locator(`[data-machine-row="${MAC}"] [data-machine-row-line]`)).toHaveText('macOS · 36 GB · 2 running')
  await expect(rows.locator(`[data-machine-row="${MAC}"] [data-machine-row-count]`)).toHaveText('2')
  await expect(rows.locator(`[data-machine-row="${WIN}"] [data-machine-row-line]`)).toHaveText('Windows · 32 GB · idle')
  await expect(rows.locator(`[data-machine-row="${MINI}"] [data-machine-row-line]`)).toHaveText('offline · seen 3d ago')

  // All computers.
  await rows.getByRole('button', { name: 'All 3' }).click()
  await expect(page.locator('[data-machines-summary]')).toHaveText('3 linked · 2 online · 2 agents running')
  await expect(page.locator(`[data-machine-card="${WIN}"] [data-machine-card-cpu]`)).toContainText('no figure on Windows')
  await expect(page.locator(`[data-machine-card="${MAC}"] [data-machine-card-cpu]`)).toContainText('43%')
  await expect(page.locator(`[data-machine-card="${MINI}"]`)).toHaveAttribute('data-offline', '')
  await shoot(page, 'all')

  // The busy Mac: memory amber, the processor from the load, Start an agent there.
  await page.locator(`[data-machine-card="${MAC}"]`).click()
  await expect(page.locator('[data-machine-meter="memory"]')).toContainText('used of 36 GB · 78%')
  await expect(page.locator('[data-machine-meter="memory"] [data-meter-warn]')).toHaveCount(1)
  await expect(page.locator('[data-machine-meter="cpu"]')).toContainText('processor, 12 cores · load 5.2')
  await expect(page.locator('[data-machine-session="s1"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start an agent there' })).toBeVisible()
  await shoot(page, 'mac')

  // Windows: No figure for the processor.
  await rows.locator(`[data-machine-row="${WIN}"] button`).first().click()
  await expect(page.locator('[data-machine-meter="cpu"]')).toContainText('No figure')
  await expect(page.locator('[data-machine-meter="cpu"]')).toContainText('Windows gives no load')
  await expect(page.locator('[data-machine-meter="cpu"] [role="meter"]')).toHaveCount(0)
  await shoot(page, 'win')

  // Offline: when it was seen, what it was last time, no meters, no Start.
  await rows.locator(`[data-machine-row="${MINI}"] button`).first().click()
  await expect(page.locator('[data-machine-offline-note]')).toContainText('Offline, seen 3d ago.')
  await expect(page.locator('[data-machine-meters]')).toHaveCount(0)
  await expect(page.getByText('Nothing runs on Office Mac mini now.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start an agent there' })).toHaveCount(0)
  await shoot(page, 'offline')

  // Back on the Mac, Start an agent there opens New agent on it.
  await rows.locator(`[data-machine-row="${MAC}"] button`).first().click()
  await page.getByRole('button', { name: 'Start an agent there' }).click()
  const sheet = page.getByRole('dialog', { name: 'New agent' })
  await expect(sheet.getByRole('combobox', { name: 'Machine', exact: true })).toHaveValue(MAC)
  await page.keyboard.press('Escape')
})
