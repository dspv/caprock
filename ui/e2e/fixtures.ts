/**
 * What every scenario shares: the stand's addresses, a page that fails the
 * test on any console error, uncaught exception or request that leaves the
 * stand, and the helpers that read a terminal.
 */
import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { readState, type StandState } from './stand'

/** The xterm the page drew for a session, as text (lib/benchhook registers it). */
async function termText(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((id) => {
    type Line = { translateToString(trim: boolean): string }
    type Term = { buffer: { active: { length: number; getLine(i: number): Line | undefined } } }
    const hook = (window as unknown as { __caprockBench?: { terms: Map<string, Term> } }).__caprockBench
    const t = hook?.terms.get(id)
    if (!t) return ''
    const b = t.buffer.active
    const lines: string[] = []
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n')
  }, sessionId)
}

export class App {
  constructor(readonly page: Page, readonly stand: StandState) {}

  /** The desktop app's workspace, as the native shell loads it. */
  async open(): Promise<void> {
    await this.page.goto(`${this.stand.pageURL}/?app=1#/app`)
    await expect(this.page.getByRole('status', { name: /Last heard from the daemon/ })).toBeVisible()
  }

  get sidebar(): Locator { return this.page.getByRole('complementary', { name: 'Projects' }) }
  get tabs(): Locator { return this.page.getByRole('tablist', { name: 'Terminals' }) }

  session(name: 'alpha' | 'beta'): StandState['sessions'][number] {
    const s = this.stand.sessions.find((x) => x.name === `e2e ${name}`)
    if (!s) throw new Error(`no session e2e ${name} on the stand`)
    return s
  }

  /** The sidebar row of a session, by its name: under a project, in the Flat list's tabbed rows or under Running, no tab. */
  row(title: string): Locator {
    return this.sidebar.getByRole('group', { name: /sessions|running, no tab/i }).getByRole('button', { name: new RegExp(`\\b${title}\\b`) })
  }

  /** Opens a session's tab from its sidebar row and waits for the fake claude. */
  async openSession(name: 'alpha' | 'beta'): Promise<StandState['sessions'][number]> {
    const s = this.session(name)
    await this.row(s.name).first().click()
    await expect(this.tabs.getByRole('tab', { name: new RegExp(`^${s.name}`), selected: true })).toBeVisible()
    await this.waitTerm(s.id, 'fake-claude ready')
    return s
  }

  async waitTerm(sessionId: string, text: string): Promise<void> {
    await expect.poll(() => termText(this.page, sessionId), { message: `terminal shows ${JSON.stringify(text)}` }).toContain(text)
  }

  termText(sessionId: string): Promise<string> { return termText(this.page, sessionId) }

  /** An app chord as this OS spells it: ⌘ on macOS, Ctrl+Shift elsewhere (lib/appkeys). */
  async chord(key: string): Promise<void> {
    const mac = await this.page.evaluate(() => /Mac|iP(hone|ad)/.test(navigator.platform || navigator.userAgent))
    await this.page.keyboard.press(mac ? `Meta+${key}` : `Control+Shift+${key.toUpperCase()}`)
  }
}

export const test = base.extend<{ app: App; stand: StandState }>({
  stand: async ({}, use) => { await use(readState()) },
  page: async ({ page, stand }, use) => {
    const problems: string[] = []
    // The console says only "Failed to load resource" for a 4xx/5xx; the
    // URL comes from its location.
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      // A chat's HTML file is shown in a frame with no scripts (ADR-071);
      // the init script below is offered to every frame, and the sandbox
      // refusing it is the sandbox working.
      if (/^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed/.test(m.text())) return
      problems.push(`console.error: ${m.text()} (${m.location().url})`)
    })
    page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`))
    // Nothing leaves the machine (CLAUDE.md rule 4): every request goes to
    // the stand, or is the page's own data.
    page.on('request', (r) => {
      const u = r.url()
      if (!u.startsWith(stand.pageURL) && !u.startsWith(stand.pageURL.replace('http', 'ws')) && !/^(data|blob):/.test(u)) {
        problems.push(`request off the stand: ${u}`)
      }
    })
    // Before the page's scripts: terminals register for termText.
    await page.addInitScript(() => {
      (window as unknown as { __caprockBench: unknown }).__caprockBench = { terms: new Map() }
    })
    await use(page)
    expect(problems, 'console errors, exceptions or off-stand requests').toEqual([])
  },
  app: async ({ page, stand }, use) => { await use(new App(page, stand)) },
})

export { expect }
