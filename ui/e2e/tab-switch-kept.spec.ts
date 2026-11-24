/**
 * Switching back to a tab is instant (.ai/04-ui.md § The app workspace,
 * *Switching tabs*): its terminal is the same xterm, never mounted again
 * and never replayed from the ring, and its inspector draws what it held on
 * the first frame — with the daemon's answers for that session held back,
 * nothing on it may read "Reading…".
 */
import type { Page } from '@playwright/test'
import { App, expect, test } from './fixtures'

type Term = { write: (d: string | Uint8Array, cb?: () => void) => void }
type Win = { __caprockBench: { terms: Map<string, Term> }; __kept?: Record<string, Term>; __written?: Record<string, number> }

/** Marks each session's xterm and counts what is written into it from now on. */
async function markTerms(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((ids) => {
    const w = window as unknown as Win
    w.__kept = {}
    w.__written = {}
    for (const id of ids) {
      const t = w.__caprockBench.terms.get(id)!
      w.__kept[id] = t
      w.__written[id] = 0
      const orig = t.write.bind(t)
      t.write = (d, cb) => { w.__written![id]! += typeof d === 'string' ? d.length : d.byteLength; orig(d, cb) }
    }
  }, ids)
}

/** The inspector's visible words. */
const inspector = (page: Page) => page.evaluate(() => (document.querySelector('aside[aria-label="Inspector"]') as HTMLElement | null)?.innerText ?? '')

test('a tab switched back to keeps its terminal and draws its inspector without waiting on a read', async ({ page, stand }) => {
  const app = new App(page, stand)
  await app.open()
  // Opened from their rows; an earlier spec's redraw may have cleared "fake-claude ready".
  const open = async (name: 'alpha' | 'beta') => {
    const s = app.session(name)
    await app.row(s.name).first().click()
    await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${s.name}`), selected: true })).toBeVisible()
    await expect.poll(() => page.evaluate((id) => (window as unknown as Win).__caprockBench.terms.has(id), s.id)).toBe(true)
    return s
  }
  const alpha = await open('alpha')
  const beta = await open('beta')
  // Each inspector has read its session once.
  await expect.poll(() => inspector(page), { timeout: 15_000 }).not.toMatch(/Reading|Loading/)
  await app.tabs.getByRole('tab', { name: new RegExp(`^${alpha.name}`) }).click()
  await expect.poll(() => inspector(page), { timeout: 15_000 }).not.toMatch(/Reading|Loading/)
  await expect.poll(() => inspector(page)).toContain(alpha.name)
  await markTerms(page, [alpha.id, beta.id])

  // From here every read about either session hangs: a view that needed one
  // to draw would sit on "Reading…".
  const held: (() => void)[] = []
  const about = (u: URL) => u.pathname.startsWith('/v1/') && (u.pathname.includes(alpha.id) || u.pathname.includes(beta.id))
  await page.route(about, (route) => {
    held.push(() => { void route.continue().catch(() => {}) })
  })
  try {
    for (const s of [beta, alpha, beta]) {
      await app.tabs.getByRole('tab', { name: new RegExp(`^${s.name}`) }).click()
      await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${s.name}`), selected: true })).toBeVisible()
      // The first frames after the click: titled, nothing being read.
      const now = await page.evaluate(() => new Promise<string>((r) => requestAnimationFrame(() => requestAnimationFrame(() =>
        r((document.querySelector('aside[aria-label="Inspector"]') as HTMLElement | null)?.innerText ?? '')))))
      expect(now).toContain(s.name)
      expect(now).not.toMatch(/Reading|Loading/)
      await expect(page.locator('aside[aria-label="Inspector"] section[aria-label="Changes"]').filter({ visible: true })).toBeVisible()
    }
    // The same xterm objects, nothing replayed into them (an idle fake
    // claude writes nothing; a replay would be the ring, kilobytes).
    const same = await page.evaluate((ids) => {
      const w = window as unknown as Win
      return ids.map((id) => ({ same: w.__caprockBench.terms.get(id) === w.__kept![id], written: w.__written![id] }))
    }, [alpha.id, beta.id])
    for (const t of same) {
      expect(t.same).toBe(true)
      expect(t.written).toBeLessThan(512)
    }
  } finally {
    await page.unroute(about).catch(() => {})
    for (const go of held) go()
  }
})
