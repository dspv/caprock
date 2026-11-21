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
    // The scenarios find a session's row in one list, the Flat one (Settings
    // → Appearance → Sidebar: Tabs): under Tree, the default since
    // 2026-11-05, a project is folded until unfolded. A scenario that sets
    // the mode itself keeps its own.
    await this.page.addInitScript(() => {
      try { if (localStorage.getItem('caprock.app.sidebar-grouped') === null) localStorage.setItem('caprock.app.sidebar-grouped', 'off') } catch { /* no storage */ }
    })
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

  /** The sidebar row of a session, by its name: in Open, under a project or under Running, no tab. */
  row(title: string): Locator {
    return this.sidebar.getByRole('group', { name: /open tabs|sessions|running, no tab/i }).getByRole('button', { name: new RegExp(`\\b${title}\\b`) })
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

/**
 * Stops an agent or shell this stand started (rule 7): the cleanup every spec
 * that starts one runs in its `finally`. A tab still open on an agent that
 * ends is turned into a shell by the app (AppShell's exit handling), so close
 * the page first, or stop that shell too (`shellIds` before and after).
 */
export async function stopAgent(daemonURL: string, id: string): Promise<void> {
  await fetch(`${daemonURL}/v1/agents/${id}/signal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'kill' }),
  }).catch(() => {})
}

/** The ids of every shell running on a stand. */
export async function shellIds(daemonURL: string): Promise<string[]> {
  return (((await (await fetch(`${daemonURL}/v1/shells`)).json()) as { shells?: { id: string }[] }).shells ?? []).map((s) => s.id)
}

/** A live session or shell on the shared stand, as the leftover check names it. */
interface LiveThing { kind: 'session' | 'shell'; id: string; name: string; cwd: string; owned: boolean }

/** What runs on the shared stand now: every session not ended, every shell. */
async function liveOnStand(daemonURL: string): Promise<LiveThing[]> {
  const sessions = await (await fetch(`${daemonURL}/v1/sessions?active=true&limit=500`)).json() as {
    session_id: string; cwd: string; status: string; owned?: boolean; name?: string; title?: string; description?: string
  }[]
  const shells = ((await (await fetch(`${daemonURL}/v1/shells`)).json()) as { shells?: { id: string; cwd: string }[] }).shells ?? []
  return [
    ...sessions.filter((s) => s.status !== 'ended').map((s) => ({
      kind: 'session' as const, id: s.session_id, cwd: s.cwd, owned: !!s.owned, name: s.name || s.title || s.description || '(unnamed)',
    })),
    ...shells.map((s) => ({ kind: 'shell' as const, id: s.id, cwd: s.cwd, owned: true, name: 'shell' })),
  ]
}

const describe = (t: LiveThing) => `${t.kind} ${t.id} "${t.name}" in ${t.cwd}`

export interface LeftoverOptions {
  /**
   * The baseline sessions (by stand name, "e2e beta") this test may end. Empty
   * by default: a spec that needs to end one starts its own instead, so the
   * specs after it still find the stand as it was set up.
   */
  mayEnd: string[]
  /** True only for a test that leaves something running for the next on purpose. None does today. */
  mayLeaveRunning: boolean
}

export const test = base.extend<{ app: App; stand: StandState; leftovers: void } & LeftoverOptions>({
  mayEnd: [[], { option: true }],
  mayLeaveRunning: [false, { option: true }],
  // The specs share one stand, run one after another: a session a test starts
  // and leaves running, or a stand session it ends, breaks a later spec — and
  // the failure lands there, not here. So every test is checked: what was not
  // live before it must not be live after it (30 s to wind down), and the
  // stand's own sessions must still be live. Always the shared stand, also in
  // a spec that brings a stand of its own (setup-checklist.spec.ts).
  leftovers: [async ({ mayEnd, mayLeaveRunning }, use, info) => {
    const shared = readState()
    const before = await liveOnStand(shared.daemonURL)
    const was = new Set(before.map((t) => t.id))
    await use()
    info.setTimeout(info.timeout + 40_000)
    const until = Date.now() + 30_000
    let left: LiveThing[] = []
    let now: LiveThing[] = []
    for (;;) {
      now = await liveOnStand(shared.daemonURL)
      left = mayLeaveRunning ? [] : now.filter((t) => !was.has(t.id))
      if (left.length === 0 || Date.now() > until) break
      await new Promise((r) => setTimeout(r, 250))
    }
    const live = new Set(now.map((t) => t.id))
    const ended = shared.sessions.filter((s) => was.has(s.id) && !live.has(s.id) && !mayEnd.includes(s.name))
    // Stopped here so the next test starts clean and the blame stays on this
    // one: these are processes this stand's daemon started (rule 7).
    for (const t of left) if (t.owned) await stopAgent(shared.daemonURL, t.id)
    expect(left.map(describe), 'this test started it and left it running — stop it in a finally').toEqual([])
    expect(ended.map((s) => `session ${s.id} "${s.name}" in ${s.cwd}`),
      'this test ended a session the stand set up for every spec — start one of its own to end instead').toEqual([])
  }, { auto: true }],
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
