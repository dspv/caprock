/**
 * A terminal stays right across tab switches, the window going out of sight
 * and its WebGL context going (.ai/04-ui.md § The app workspace, *Terminal*).
 * The fake claude's `agents` command redraws a live subagent list in place
 * the way Claude Code's renderer does (testdata/fakeclaude/agents.go): a
 * terminal that parsed every byte in order shows one copy of it, and a
 * terminal that draws what it parsed shows the same pixels after every row
 * is drawn again. Runs after golden.spec.ts: a repaint here clears the
 * viewport, `fake-claude ready` with it.
 */
import type { Page } from '@playwright/test'
import { App, expect, test } from './fixtures'

type Bench = { __caprockBench: { terms: Map<string, unknown> } }

/**
 * The list's rows on screen: the viewport only, as the scrollback above it
 * can hold an earlier run's rows replayed from the ring when a page attaches
 * (the ring starts mid-frame).
 */
async function listRows(page: Page, id: string): Promise<string[]> {
  return page.evaluate((sid) => {
    type Line = { translateToString(trim: boolean): string }
    type Term = { rows: number; buffer: { active: { baseY: number; getLine(i: number): Line | undefined } } }
    const t = (window as unknown as Bench).__caprockBench.terms.get(sid) as Term | undefined
    if (!t) return []
    const b = t.buffer.active
    const rows: string[] = []
    for (let i = b.baseY; i < b.baseY + t.rows; i++) {
      const s = b.getLine(i)?.translateToString(true) ?? ''
      if (s.includes('subagent-')) rows.push(s.trim())
    }
    return rows
  }, id)
}

/** The last frame of `agents n`: two rows, nothing left of the others. */
const lastFrame = (n: number) => [`⎿ subagent-1 step ${n}`, `⎿ subagent-2 step ${n}`]

/**
 * Out of sight and back, as a covered or minimised window is (lib/visible):
 * the visibility the page reads, and no animation frame while hidden.
 */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    const w = window as unknown as { __vis?: string; __rafq?: FrameRequestCallback[] }
    if (w.__vis === undefined) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => w.__vis })
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => w.__vis === 'hidden' })
      const raf = window.requestAnimationFrame.bind(window)
      w.__rafq = []
      window.requestAnimationFrame = (cb) => {
        if (w.__vis === 'hidden') { w.__rafq!.push(cb); return 0 }
        return raf(cb)
      }
    }
    w.__vis = h ? 'hidden' : 'visible'
    if (h) window.dispatchEvent(new Event('blur'))
    else for (const cb of w.__rafq!.splice(0)) window.requestAnimationFrame(cb)
    document.dispatchEvent(new Event('visibilitychange'))
    if (!h) window.dispatchEvent(new Event('focus'))
  }, hidden)
}

/**
 * Whether the grid on screen is what xterm would draw now: a screenshot as
 * drawn, then one after every terminal's rows are drawn again from a fresh
 * atlas (all of them: the atlas is shared, lib/termfont clearGlyphAtlas).
 */
async function paintIsCurrent(page: Page, id: string): Promise<boolean> {
  const grid = page.locator(`[data-term-session="${id}"] .xterm-screen`)
  // A blinking cursor would differ between any two shots.
  await page.evaluate((sid) => {
    const t = (window as unknown as Bench).__caprockBench.terms.get(sid) as { options: { cursorBlink: boolean } }
    t.options.cursorBlink = false
  }, id)
  await page.waitForTimeout(700)
  const before = await grid.screenshot()
  await page.evaluate(() => new Promise<void>((done) => {
    type T = { rows: number; refresh(a: number, b: number): void; clearTextureAtlas(): void }
    for (const t of (window as unknown as Bench).__caprockBench.terms.values() as Iterable<T>) {
      t.clearTextureAtlas()
      t.refresh(0, t.rows - 1)
    }
    requestAnimationFrame(() => requestAnimationFrame(() => done()))
  }))
  return before.equals(await grid.screenshot())
}

/** The WebGL context the terminal draws with, if any: alive, or gone. */
async function glState(page: Page, id: string): Promise<'none' | 'alive' | 'lost'> {
  return page.evaluate((sid) => {
    type T = { _core?: { _renderService?: { _renderer?: { value?: { _gl?: WebGL2RenderingContext } } } } }
    const gl = ((window as unknown as Bench).__caprockBench.terms.get(sid) as T | undefined)?._core?._renderService?._renderer?.value?._gl
    return !gl ? 'none' : gl.isContextLost() ? 'lost' : 'alive'
  }, id)
}

/** Takes the terminal's WebGL context away, as a GPU reset or a sleep does; `restoreAfterMs` gives it back. */
async function loseContext(page: Page, id: string, restoreAfterMs?: number): Promise<boolean> {
  return page.evaluate(([sid, ms]) => {
    for (const c of document.querySelectorAll<HTMLCanvasElement>(`[data-term-session="${sid}"] canvas`)) {
      const ext = c.getContext('webgl2')?.getExtension('WEBGL_lose_context')
      if (!ext) continue
      ext.loseContext()
      if (typeof ms === 'number') setTimeout(() => ext.restoreContext(), ms)
      return true
    }
    return false
  }, [id, restoreAfterMs] as const)
}

/** Whether this browser gives a page WebGL 2 at all (a CI runner without a GPU may not). */
async function hasWebgl(page: Page): Promise<boolean> {
  return page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))
}

/** A session's tab, in front, its terminal drawn. */
async function openTab(app: App, page: Page, name: 'alpha' | 'beta') {
  const s = app.session(name)
  await app.row(s.name).first().click()
  await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${s.name}`), selected: true })).toBeVisible()
  await expect.poll(() => app.termText(s.id)).not.toBe('')
  await expect(page.locator(`[data-term-session="${s.id}"] .xterm-screen`)).toBeVisible()
  return s
}

async function type(page: Page, line: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Terminal input' }).first().focus()
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
}

test('the list is drawn once after the window was out of sight while it ran', async ({ app, page }) => {
  await app.open()
  const s = await openTab(app, page, 'alpha')
  await type(page, 'agents 300')
  await page.waitForTimeout(1500)
  // Past PAGE_HIDDEN_SUSPEND_MS: the socket goes and resumes from its last byte.
  await setHidden(page, true)
  await page.waitForTimeout(5000)
  await setHidden(page, false)
  await app.waitTerm(s.id, 'agents-done 300')
  await page.waitForTimeout(500)
  expect(await listRows(page, s.id)).toEqual(lastFrame(300))
  expect(await paintIsCurrent(page, s.id)).toBe(true)
})

test('the list is drawn once after its tab was behind another while it ran', async ({ app, page }) => {
  await app.open()
  const s = await openTab(app, page, 'beta')
  await type(page, 'agents 300')
  await page.waitForTimeout(1500)
  // Past HIDDEN_HOLD_BYTES held: the socket goes and resumes when shown.
  await app.row(app.session('alpha').name).first().click()
  await page.waitForTimeout(5000)
  await app.row(s.name).first().click()
  await app.waitTerm(s.id, 'agents-done 300')
  await page.waitForTimeout(500)
  expect(await listRows(page, s.id)).toEqual(lastFrame(300))
  expect(await paintIsCurrent(page, s.id)).toBe(true)
})

// Before: three seconds on a dead canvas after the event (the addon's wait
// for a restore), and for good without it.
for (const mode of ['told', 'silent'] as const) {
  test(`a lost WebGL context is replaced at once, never drawn on (${mode})`, async ({ app, page }) => {
    await app.open()
    test.skip(!(await hasWebgl(page)), 'no WebGL 2 in this browser')
    const s = await openTab(app, page, mode === 'told' ? 'alpha' : 'beta')
    await type(page, 'agents 200')
    await expect.poll(() => glState(page, s.id), { timeout: 8000 }).toBe('alive')
    if (mode === 'silent') {
      // WebKit can let a context go without telling the page: nothing on
      // the canvas hears the event.
      await page.evaluate(() => document.addEventListener('webglcontextlost', (e) => e.stopPropagation(), true))
    }
    expect(await loseContext(page, s.id)).toBe(true)
    await page.waitForTimeout(600)
    expect(await glState(page, s.id)).not.toBe('lost')
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    expect(await glState(page, s.id)).not.toBe('lost')
    await app.waitTerm(s.id, 'agents-done 200')
    // A fresh context after the quiet wait.
    await expect.poll(() => glState(page, s.id), { timeout: 8000 }).toBe('alive')
    expect(await listRows(page, s.id)).toEqual(lastFrame(200))
    expect(await paintIsCurrent(page, s.id)).toBe(true)
  })
}

// A context given back is not rebuilt in place: in WebKit that path deleted
// the old context's objects through the new one, a console error each.
test('a WebGL context given back after a loss leaves no errors and a current screen', async ({ app, page }) => {
  await app.open()
  test.skip(!(await hasWebgl(page)), 'no WebGL 2 in this browser')
  const s = await openTab(app, page, 'alpha')
  await type(page, 'agents 200')
  await expect.poll(() => glState(page, s.id), { timeout: 8000 }).toBe('alive')
  expect(await loseContext(page, s.id, 500)).toBe(true)
  await app.waitTerm(s.id, 'agents-done 200')
  await expect.poll(() => glState(page, s.id), { timeout: 8000 }).toBe('alive')
  expect(await listRows(page, s.id)).toEqual(lastFrame(200))
  expect(await paintIsCurrent(page, s.id)).toBe(true)
})

test('the input box key hint goes when the window loses focus', async ({ app, page }) => {
  await app.open()
  const s = await openTab(app, page, 'beta')
  await type(page, 'box')
  await app.waitTerm(s.id, '❯ type here')
  const at = await page.evaluate((sid) => {
    type Line = { translateToString(trim: boolean): string }
    type T = { rows: number; buffer: { active: { viewportY: number; getLine(i: number): Line | undefined } } }
    const t = (window as unknown as Bench).__caprockBench.terms.get(sid) as T
    let row = -1
    for (let i = 0; i < t.rows; i++) if (t.buffer.active.getLine(t.buffer.active.viewportY + i)?.translateToString(true).startsWith('❯ type here')) row = i
    const r = document.querySelector(`[data-term-session="${sid}"] .xterm-screen`)!.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + (row + 0.5) * (r.height / t.rows) }
  }, s.id)
  await page.mouse.move(at.x, at.y)
  await expect(page.locator('[data-input-hint]')).toBeVisible()
  // Another app in front: the pointer leaves with the window, and no mouseleave comes.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(page.locator('[data-input-hint]')).toHaveCount(0)
})
