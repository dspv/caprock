/**
 * ⌘W (Ctrl+Shift+W off macOS), the desktop app's Close Tab and the tab's ×
 * close an agent's tab alike (owner, 2026-11-22, translated: "closing tabs
 * with ⌘W gives no question, unlike closing with the × … there must be one
 * single way of ending"). Driven as a person drives them against the
 * sandboxed stand: with the focus in the terminal, in the chat view and in
 * the sidebar; on one pane of a split; on an agent that is answering and on
 * one that is idle.
 */
import type { Page } from '@playwright/test'
import { expect, shellIds, stopAgent, test, type App } from './fixtures'

/**
 * The fake claude never answers, so the daemon calls it idle: the page is
 * told it is `health` instead, in every answer that carries the session.
 */
async function sayHealth(page: Page, id: string, health: string): Promise<void> {
  await page.route((u) => u.pathname === '/v1/sessions' || u.pathname.startsWith('/v1/sessions/'), async (route) => {
    const r = await route.fetch()
    if (!(r.headers()['content-type'] ?? '').includes('json')) { await route.fulfill({ response: r }); return }
    const body = await r.json() as unknown
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(walk); return }
      if (!v || typeof v !== 'object') return
      const o = v as Record<string, unknown>
      if (o.session_id === id && o.activity && typeof o.activity === 'object') (o.activity as Record<string, unknown>).health = health
      Object.values(o).forEach(walk)
    }
    walk(body)
    await route.fulfill({ response: r, json: body })
  })
}

/** An agent of this test's own, named, so ending it leaves the stand's sessions alone. */
async function startAgent(app: App, name: string): Promise<string> {
  const r = await fetch(`${app.stand.daemonURL}/v1/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: app.session('beta').cwd }) })
  const { session_id: id } = await r.json() as { session_id: string }
  expect(r.ok && id, 'spawn').toBeTruthy()
  await fetch(`${app.stand.daemonURL}/v1/sessions/${id}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
  return id
}

const QUESTION = "Close an agent's tab"
const SAVED = 'Closed. The conversation is saved — reopen it from History or the sidebar.'

test('an answering agent’s tab asks the same question on ⌘W, from the terminal, the chat view and the sidebar, as on its ×', async ({ app, page }) => {
  const name = 'e2e close asks'
  const id = await startAgent(app, name)
  try {
    await sayHealth(page, id, 'working')
    await app.open()
    await app.row(name).first().click()
    const tab = app.tabs.getByRole('tab', { name: new RegExp(`^${name}`) })
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await app.waitTerm(id, 'fake-claude ready')
    const sheet = page.getByRole('dialog', { name: QUESTION })
    const ways: [string, () => Promise<void>][] = [
      ['the tab’s ×', () => tab.getByRole('button', { name: /^Close/ }).click()],
      ['⌘W in the terminal', async () => { await page.locator('.xterm-helper-textarea').first().focus(); await app.chord('w') }],
      ['⌘W in the chat view', async () => {
        await page.locator('[data-view-switch][data-view="chat"]').click()
        await page.locator('textarea:visible').first().focus()
        await app.chord('w')
      }],
      ['⌘W in the sidebar', async () => { await app.row(name).first().focus(); await app.chord('w') }],
      // The desktop app's File → Close Tab holds ⌘W on macOS and tells the page (main.rs CLOSE_TAB_JS).
      ['Close Tab in the app menu', () => page.evaluate(() => { window.dispatchEvent(new Event('caprock:close-tab')) })],
    ]
    let first: string | null = null
    for (const [way, close] of ways) {
      await tab.click()
      await close()
      await expect(sheet, way).toBeVisible()
      const text = await sheet.textContent()
      first ??= text
      expect(text, way).toBe(first)
      // Escape: nothing closes and nothing stops.
      await page.keyboard.press('Escape')
      await expect(sheet).toHaveCount(0)
      await expect(tab).toHaveCount(1)
      const back = page.locator('[data-view-switch][data-view="terminal"]')
      if (await back.count()) await back.click()
    }
    // Keep it running, from ⌘W then Enter: the tab goes, the agent works on.
    await tab.click()
    await page.locator('.xterm-helper-textarea').first().focus()
    await app.chord('w')
    await expect(sheet).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(tab).toHaveCount(0)
    const s = await (await fetch(`${app.stand.daemonURL}/v1/sessions/${id}`)).json() as { status?: string }
    expect(s.status).not.toBe('ended')
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await page.close()
    await stopAgent(app.stand.daemonURL, id)
  }
})

test('on one pane of a split, ⌘W asks about the focused agent as its pane’s × does', async ({ app, page }) => {
  const name = 'e2e close split'
  const id = await startAgent(app, name)
  const shellsBefore = new Set(await shellIds(app.stand.daemonURL))
  try {
    await sayHealth(page, id, 'working')
    await app.open()
    await app.row(name).first().click()
    const tab = app.tabs.getByRole('tab', { name: new RegExp(`^${name}`) })
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await app.waitTerm(id, 'fake-claude ready')
    // A shell beside it (⌘E), then back to the agent's pane.
    await app.chord('e')
    const panes = page.locator('[data-pane]')
    await expect(panes).toHaveCount(2)
    const closePane = page.getByRole('button', { name: new RegExp(`^Close pane ${name}`) })
    const agentPane = panes.filter({ has: closePane })
    const sheet = page.getByRole('dialog', { name: QUESTION })
    await closePane.click()
    await expect(sheet).toBeVisible()
    const byX = await sheet.textContent()
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await agentPane.locator('.xterm-helper-textarea').focus()
    await expect(agentPane).toHaveAttribute('data-focused', 'true')
    await app.chord('w')
    await expect(sheet).toBeVisible()
    expect(await sheet.textContent()).toBe(byX)
    await page.keyboard.press('Escape')
    await expect(panes).toHaveCount(2)
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await page.close()
    await stopAgent(app.stand.daemonURL, id)
    // The shell ⌘E started beside it.
    for (const s of await shellIds(app.stand.daemonURL)) if (!shellsBefore.has(s)) await stopAgent(app.stand.daemonURL, s)
  }
})

test('an idle agent’s tab ends with no question and the same toast on ⌘W as on its ×', async ({ app, page }) => {
  const names = ['e2e close idle x', 'e2e close idle key']
  const ids = [await startAgent(app, names[0]!), await startAgent(app, names[1]!)]
  try {
    await app.open()
    for (const [i, name] of names.entries()) {
      const id = ids[i]!
      await app.row(name).first().click()
      const tab = app.tabs.getByRole('tab', { name: new RegExp(`^${name}`) })
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      await app.waitTerm(id, 'fake-claude ready')
      if (i === 0) await tab.getByRole('button', { name: /^Close/ }).click()
      else { await page.locator('.xterm-helper-textarea').first().focus(); await app.chord('w') }
      await expect(tab).toHaveCount(0)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByText(SAVED)).toBeVisible()
      // Ended, SIGTERM first, so it can be continued.
      await expect.poll(async () => ((await (await fetch(`${app.stand.daemonURL}/v1/sessions/${id}`)).json()) as { status?: string }).status, { timeout: 15_000 }).toBe('ended')
    }
  } finally {
    await page.close()
    for (const id of ids) await stopAgent(app.stand.daemonURL, id)
  }
})
