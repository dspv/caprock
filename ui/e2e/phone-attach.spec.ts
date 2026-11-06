/**
 * Attaching from a phone: the Attach button offers Photos and Files, each
 * opens its own picker, and what is picked reaches the daemon (owner,
 * 2026-11-06: "I can't attach anything on the phone"). The phone's New
 * chat, a chat, and a session's chat on the Full dashboard; with a mouse the
 * one picker opens straight away.
 *
 * CAPROCK_E2E_SHOTS=<dir> also saves a screenshot of each menu there.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { devices, type Browser, type Page } from '@playwright/test'
import { expect, test } from './fixtures'

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const SHOTS = process.env.CAPROCK_E2E_SHOTS

async function phone(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } })
  const page = await ctx.newPage()
  await page.addInitScript(() => { try { localStorage.setItem('caprock.phone.installHint', '1') } catch { /* no storage */ } })
  return { page, close: () => ctx.close() }
}

async function shot(page: Page, name: string): Promise<void> {
  const file = SHOTS ? path.join(SHOTS, `${name}.png`) : test.info().outputPath(`${name}.png`)
  if (SHOTS) mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: file })
}

/** Opens the menu under `button`, picks `which`, and hands the chooser `file`. */
async function pick(page: Page, button: ReturnType<Page['getByRole']>, which: 'Photos' | 'Files', file: { name: string; mimeType: string; buffer: Buffer }, name: string): Promise<string> {
  await button.click()
  const menu = page.getByRole('menu', { name: 'Attach from' })
  await expect(menu.getByRole('menuitem')).toHaveCount(2)
  await expect(menu.getByRole('menuitem', { name: /Photos/ })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Files/ })).toBeVisible()
  if (which === 'Photos') await shot(page, name)
  const chooser = page.waitForEvent('filechooser')
  await menu.getByRole('menuitem', { name: new RegExp(which) }).click()
  const fc = await chooser
  expect(fc.isMultiple()).toBe(true)
  const accept = (await fc.element().getAttribute('accept')) ?? ''
  await fc.setFiles(file)
  await expect(menu).toBeHidden()
  return accept
}

const photo = { name: 'IMG_0001.png', mimeType: 'image/png', buffer: PNG }
const notes = { name: 'meeting-notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n') }

test('on a phone, Attach offers Photos and Files, and both reach the daemon', async ({ app, browser, stand }) => {
  test.setTimeout(120_000)
  const s = app.session('alpha')
  const r = await fetch(`${stand.daemonURL}/v1/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat: true }) })
  const chat = await r.json() as { session_id: string }
  expect(r.ok, JSON.stringify(chat)).toBe(true)
  const pasteDir = path.join(stand.dir, 'data', 'paste')

  const { page, close } = await phone(browser)
  page.setDefaultTimeout(8000)
  try {
    // The phone's New chat.
    await page.goto(`${stand.pageURL}/#/`)
    await page.getByRole('button', { name: 'New chat' }).click()
    const dock = page.getByRole('button', { name: 'Attach a photo or file' }).first()
    await expect(dock).toBeVisible({ timeout: 15_000 })
    expect(await pick(page, dock, 'Photos', photo, 'home-menu')).toBe('image/*')
    await expect(page.locator('img[src^="blob:"]').first()).toBeVisible()
    const filesAccept = await pick(page, dock, 'Files', notes, 'home-files')
    expect(filesAccept.split(',')).toEqual(expect.arrayContaining(['.pdf', '.md']))
    expect(filesAccept).not.toContain('image/')
    expect(filesAccept.split(',')).not.toContain('.png')
    expect(filesAccept.split(',')).not.toContain('.ts')
    await expect(page.locator('[data-file-chip]', { hasText: 'meeting-notes.md' })).toBeVisible()

    // A chat on the phone, then a session's chat on the Full dashboard: the
    // pick is saved by the daemon and shows as a chip over the field.
    for (const [where, hash] of [['chat', `#/chats/${chat.session_id}`], ['full-dashboard', `#/session/${s.id}?tab=chat`]] as const) {
      await page.goto(`${stand.pageURL}/${hash}`)
      const attach = page.getByRole('button', { name: 'Attach a photo or file' }).last()
      await expect(attach).toBeVisible({ timeout: 15_000 })
      await pick(page, attach, 'Photos', photo, `${where}-menu`)
      await expect(page.getByText('Image 1').filter({ visible: true }).first()).toBeVisible()
      await pick(page, attach, 'Files', notes, `${where}-files`)
      await expect(page.getByText('meeting-notes.md').filter({ visible: true }).first()).toBeVisible()
      await shot(page, `${where}-attached`)
    }
    // Both pages saved both picks: two photos and two notes on the daemon.
    expect(existsSync(pasteDir), `${pasteDir} exists`).toBe(true)
    const saved = readdirSync(pasteDir, { recursive: true }).map(String)
    expect(saved.filter((f) => f.endsWith('.png')).length, saved.join(', ')).toBeGreaterThanOrEqual(2)
    expect(saved.filter((f) => f.endsWith('meeting-notes.md')).length, saved.join(', ')).toBeGreaterThanOrEqual(2)
  } finally {
    await close()
  }
})

test('with a mouse, Attach opens the one picker that takes everything', async ({ browser, stand }) => {
  const r = await fetch(`${stand.daemonURL}/v1/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat: true }) })
  const chat = await r.json() as { session_id: string }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  try {
    await page.goto(`${stand.pageURL}/#/chats/${chat.session_id}`)
    const attach = page.getByRole('button', { name: 'Attach a photo or file' }).last()
    await expect(attach).toBeVisible({ timeout: 15_000 })
    const chooser = page.waitForEvent('filechooser')
    await attach.click()
    const fc = await chooser
    expect(await fc.element().getAttribute('accept')).toMatch(/^image\/\*,\.png,/)
    await expect(page.getByRole('menu', { name: 'Attach from' })).toHaveCount(0)
    await fc.setFiles(photo)
    await expect(page.getByText('Image 1').filter({ visible: true }).first()).toBeVisible()
  } finally {
    await ctx.close()
  }
})
