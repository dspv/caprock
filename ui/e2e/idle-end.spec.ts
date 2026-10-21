/**
 * Ending idle sessions (owner, 2026-10-21; .ai/03-contracts.md § Ending idle
 * sessions), the two halves a person reaches against the sandboxed stand:
 * the app tells the daemon which sessions have a tab (PUT /v1/tabs, kept in
 * the data directory's open-tabs.json), and Settings → New sessions → End
 * idle chats after stores the window. The end itself waits 12 hours, so it
 * is driven with an injected clock in internal/daemon/endidle_test.go.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures'

function tabsFile(dir: string): string {
  try { return readFileSync(path.join(dir, 'data', 'open-tabs.json'), 'utf8') } catch { return '' }
}

test('a tab the app opens is reported to the daemon, so that session is never ended for idling', async ({ app, stand }) => {
  await app.open()
  const s = await app.openSession('beta')
  await expect.poll(() => tabsFile(stand.dir), { message: 'open-tabs.json lists the tab' }).toContain(s.id)
})

test('Settings → New sessions offers End idle chats after, 12 h until chosen, and keeps the choice', async ({ page, stand }) => {
  await page.goto(`${stand.pageURL}/?app=1#/settings`)
  const group = page.getByRole('radiogroup', { name: 'End idle chats after' })
  await expect(group.getByRole('radio')).toHaveText(['2 h', '12 h', '24 h', 'Never'])
  await expect(group.getByRole('radio', { name: '12 h' })).toHaveAttribute('aria-checked', 'true')
  await group.getByRole('radio', { name: '24 h' }).click()
  await expect.poll(async () => (await (await fetch(`${stand.daemonURL}/v1/settings`)).json() as { end_idle_after?: string }).end_idle_after).toBe('24h')
  await page.reload()
  await expect(page.getByRole('radiogroup', { name: 'End idle chats after' }).getByRole('radio', { name: '24 h' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('radiogroup', { name: 'End idle chats after' }).getByRole('radio', { name: '12 h' }).click()
  await expect.poll(async () => (await (await fetch(`${stand.daemonURL}/v1/settings`)).json() as { end_idle_after?: string }).end_idle_after).toBe('12h')
})
