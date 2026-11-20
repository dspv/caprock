/**
 * The setup checklist on a computer Caprock was just installed on (ADR-099
 * and its amendment of 2026-11-20), on a stand of its own with no project
 * and no session, the page spelled as on Windows.
 *
 * The owner's Windows PC, translated: "Clicked Install Git — it went to
 * Projects and nothing happens"; the second click worked. With no project,
 * the first shell tab was filed under none and the workspace showed Outside
 * projects' empty page as soon as the shell was listed. Here the first
 * click opens the shell tab in front, and only one shell is started.
 *
 * Also: the agents are switches kept by the daemon, and *Projects here* is
 * optional, last, and opens Add project on Clone into ~/dev in full.
 */
import { startStand, type StandState } from './stand'
import { expect, test as base } from './fixtures'

let bare: StandState | undefined
let stopBare: (() => Promise<void>) | undefined

const test = base.extend<{ stand: StandState }>({
  stand: async ({}, use) => {
    if (!bare) throw new Error('the bare stand did not start')
    await use(bare)
  },
})

test.describe('the setup checklist on a fresh computer', () => {
  test.describe.configure({ timeout: 90_000 })
  test.beforeAll(async () => {
    const s = await startStand({ bare: true })
    bare = s.state
    stopBare = s.stop
  })
  test.afterAll(async () => { await stopBare?.() })

  test('the first Sign in opens its shell tab in front, one shell; switches and the optional project', async ({ app, page, stand }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' })
      // The inspector closed: its Changes asks a shell in the home folder,
      // which is no repository, for its diff, and the 409 is logged as a
      // failed load. That is the inspector's, not the checklist's.
      try { localStorage.setItem('caprock.app.ui', JSON.stringify({ cockpit: false })) } catch { /* no storage */ }
    })
    await app.open()
    await page.goto(`${stand.pageURL}/?app=1#/settings/computers`)
    await page.getByRole('radio', { name: /Run agents for another computer/ }).click()
    const list = page.locator('[data-setup-checklist]')
    await expect(list).toBeVisible()

    // The order: Git (on Windows and macOS), Agents, the link, Projects here last.
    const keys = await list.locator('[data-setup-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-setup-item')))
    expect(keys.slice(-3)).toEqual(['agent', 'link', 'project'])

    // Claude Code: on by default, installed (the stand's fake), not signed in.
    const claude = list.locator('[data-setup-agent="claude"]')
    await expect(claude.getByRole('switch', { name: 'Claude Code: on' })).toBeVisible()
    await expect(list.getByRole('switch', { name: 'Codex: off' })).toBeVisible()

    // The first click: the shell tab is in front, and stays there once the
    // session list knows the shell.
    await claude.getByRole('button', { name: 'Sign in' }).click()
    const tab = app.tabs.getByRole('tab', { selected: true })
    await expect(tab).toBeVisible()
    await expect(page.locator('[data-dashboard-view]')).toBeHidden()
    await page.waitForTimeout(3000)
    await expect(app.tabs.getByRole('tab', { selected: true })).toBeVisible()
    const shells = await (await fetch(`${stand.daemonURL}/v1/shells`)).json() as { shells: { id: string }[] }
    expect(shells.shells).toHaveLength(1)
    await app.waitTerm(shells.shells[0]!.id, 'auth login')

    // A switch is kept by the daemon.
    await page.goto(`${stand.pageURL}/?app=1#/settings/computers`)
    await list.getByRole('switch', { name: 'Codex: off' }).click()
    await expect(list.getByRole('switch', { name: 'Codex: on' })).toBeVisible()
    await expect(list.locator('[data-setup-agent="codex"]').getByRole('button', { name: 'Install' })).toBeVisible()
    const rep = await (await fetch(`${stand.daemonURL}/v1/setup`)).json() as { agents: { id: string; on: boolean }[] }
    expect(rep.agents.find((a) => a.id === 'codex')?.on).toBe(true)
    await list.getByRole('switch', { name: 'Codex: on' }).click()
    await expect(list.getByRole('switch', { name: 'Codex: off' })).toBeVisible()

    // Projects here: optional, a dashed circle, never a step; Clone opens
    // Add project on Clone into ~/dev, in full.
    const project = list.locator('[data-setup-item="project"]')
    await expect(project).toHaveAttribute('data-optional', 'yes')
    await expect(project.locator('[data-setup-mark="dashed"]')).toBeVisible()
    await expect(project).toContainText('Optional. Clone a repository here into')
    await project.getByRole('button', { name: 'Clone' }).click()
    const field = page.getByRole('textbox', { name: /^Clone into/ })
    await expect(field).toHaveValue(/[\\/]dev[\\/]$/)
    await expect(page.getByText('Projects are cloned into this folder; change it here.')).toBeVisible()
    // The field shows `~/dev/` until the home folder is read, then the full
    // path: read at once, it was sometimes still the short form.
    await expect(field).not.toHaveValue(/^~/)
  })
})
