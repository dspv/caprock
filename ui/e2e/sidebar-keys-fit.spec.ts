/**
 * The folded sidebar footer's keys on every OS (owner, 2026-11-28,
 * translated: "on Windows, above the bottom menu panel there are no keyboard
 * shortcuts — and remember they must fit correctly there"). The page is told
 * its OS the way the app decides it (`navigator.platform`, lib/appmode
 * isMacPlatform). On a Mac the six chips are ⇧⌘F ⇧⌘M ⌘D ⌘, ⌘P ⌥⌘P; off macOS
 * the shared Ctrl+Shift is written once above the row and each chip holds
 * what is left (Alt+F, M, D, ",", P, Alt+P). At 240, 260 (the app's) and
 * 320px every chip drawn is inside its column and the sidebar, no two
 * overlap, and nothing scrolls sideways: none of this shows in jsdom.
 *
 * With CAPROCK_SHOTS_DIR set it photographs the footer at each OS and width.
 */
import path from 'node:path'
import { expect, test } from './fixtures'

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''

const OSES = [
  { name: 'mac', platform: 'MacIntel', prefix: '', chips: ['⇧⌘F', '⇧⌘M', '⌘D', '⌘,', '⌘P', '⌥⌘P'] },
  { name: 'windows', platform: 'Win32', prefix: 'Ctrl+Shift +', chips: ['Alt+F', 'M', 'D', ',', 'P', 'Alt+P'] },
  { name: 'linux', platform: 'Linux x86_64', prefix: 'Ctrl+Shift +', chips: ['Alt+F', 'M', 'D', ',', 'P', 'Alt+P'] },
] as const

const FULL = ['Ctrl+Alt+Shift+F', 'Ctrl+Shift+M', 'Ctrl+Shift+D', 'Ctrl+Shift+,', 'Ctrl+Shift+P', 'Ctrl+Alt+Shift+P']

for (const os of OSES) {
  for (const width of [240, 260, 320]) {
    test(`on ${os.name} at a ${width}px sidebar the folded footer shows every key, whole and inside its column`, async ({ app, page }) => {
      await page.addInitScript(({ platform }) => {
        Object.defineProperty(navigator, 'platform', { get: () => platform })
        try { localStorage.setItem('caprock.app.project-folds', JSON.stringify(['footer'])) } catch { /* no storage */ }
      }, { platform: os.platform })
      await app.open()
      await page.evaluate((w) => document.documentElement.style.setProperty('--app-sidebar-w', `${w}px`), width)
      const footer = page.locator('[data-folded-keys]')
      await expect(footer).toBeVisible()
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      await page.waitForTimeout(150)

      const m = await page.evaluate(() => {
        const row = document.querySelector<HTMLElement>('[data-folded-keys]')!
        const band = row.closest<HTMLElement>('[data-sidebar-footer]')!
        const aside = row.closest<HTMLElement>('aside') ?? band
        const r = (el: Element) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom } }
        const slots = [...row.querySelectorAll<HTMLElement>('[data-key-slot]')]
        const prefix = band.querySelector<HTMLElement>('[data-key-prefix]')
        return {
          mode: row.getAttribute('data-folded-keys'),
          prefix: prefix ? prefix.textContent!.trim() : '',
          prefixBox: prefix ? r(prefix) : null,
          sidebar: r(aside),
          bandScrolls: band.scrollWidth > band.clientWidth + 0.5 || row.scrollWidth > row.clientWidth + 0.5,
          chips: slots.map((s) => {
            const k = s.querySelector<HTMLElement>('[data-key-chip]')
            const button = s.querySelector('button')!
            return k && {
              text: k.textContent!, dropped: k.hasAttribute('data-dropped'),
              visible: getComputedStyle(k).visibility === 'visible',
              title: k.title || button.getAttribute('title') || button.getAttribute('aria-label') || '',
              clipped: k.scrollWidth > k.clientWidth + 0.5,
              box: r(k), slot: r(s),
            }
          }).filter(Boolean),
        }
      })
      console.log(`${os.name} ${width}px: ${m.mode} "${m.prefix}" ${m.chips.map((c) => `${c!.text}=${(c!.box.right - c!.box.left).toFixed(1)}`).join(' ')}`)

      if (shotsDir) {
        const box = (await page.locator('[data-folded-keys]').locator('xpath=ancestor-or-self::*[@data-sidebar-footer][1]').boundingBox())!
        await page.screenshot({ path: path.join(shotsDir, `sidebar-keys-${os.name}-${width}.png`), clip: { x: 0, y: box.y - 24, width: width + 24, height: box.height + 32 } })
      }

      expect(m.mode).toBe(os.name === 'mac' ? 'shown' : 'prefixed')
      expect(m.prefix).toBe(os.prefix)
      expect(m.chips.map((c) => c!.text)).toEqual([...os.chips])
      expect(m.bandScrolls).toBe(false)
      // The app's sidebar is 260px: there and wider every chip is drawn. At
      // 240 (narrower than the app draws) the widest goes first on every OS,
      // the rest still whole (fitFoldedChips).
      if (width >= 260) expect(m.chips.filter((c) => c!.dropped).map((c) => c!.text)).toEqual([])
      else expect(m.chips.filter((c) => !c!.dropped).length).toBeGreaterThanOrEqual(3)
      const drawn = m.chips.filter((c) => !c!.dropped)
      for (const c of m.chips) if (c!.dropped) expect(c!.visible, c!.text).toBe(false)
      for (const [i, c] of drawn.entries()) {
        expect(c!.visible, c!.text).toBe(true)
        expect(c!.clipped, c!.text).toBe(false)
        // Inside its column and the sidebar.
        expect(c!.box.left, c!.text).toBeGreaterThanOrEqual(c!.slot.left - 0.5)
        expect(c!.box.right, c!.text).toBeLessThanOrEqual(c!.slot.right + 0.5)
        expect(c!.box.right, c!.text).toBeLessThanOrEqual(m.sidebar.right + 0.5)
        // No two chips overlap.
        if (i > 0) expect(c!.box.left, c!.text).toBeGreaterThanOrEqual(drawn[i - 1]!.box.right - 0.5)
      }
      // Every chip's tooltip spells the whole key.
      if (os.name !== 'mac') for (const [i, c] of m.chips.entries()) expect(c!.title, c!.text).toContain(FULL[i])
      if (m.prefixBox) {
        expect(m.prefixBox.right).toBeLessThanOrEqual(m.sidebar.right + 0.5)
        expect(m.prefixBox.bottom).toBeLessThanOrEqual(Math.min(...drawn.map((c) => c!.box.top)) + 0.5)
      }
    })
  }
}
