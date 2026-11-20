/**
 * An agent typed into a shell tab (.ai/04-ui.md § An agent in a shell):
 * `claude` run at a shell's prompt on the sandboxed stand, its hooks posted
 * with its pid as the shim would, and the inspector shows that session's
 * cockpit with the shell's actions at the bottom; ⌘W asks a question that
 * names the session, lists the shell's processes and has keys — Enter
 * keeps, ⌘Enter stops, Esc cancels. With CAPROCK_SHOTS_DIR set it
 * photographs the inspector and the question in Dark Pastel and Light.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''

async function theme(page: Page, which: 'dark' | 'light') {
  await page.evaluate((w) => {
    const el = document.documentElement
    el.removeAttribute('data-dark')
    el.removeAttribute('data-tone')
    el.setAttribute('data-theme', w)
    el.setAttribute(w === 'dark' ? 'data-dark' : 'data-tone', w === 'dark' ? 'pastel' : 'white')
  }, which)
}

test('an agent typed into a shell: its cockpit in the inspector, named in the close question', async ({ app, page, stand }) => {
  test.skip(process.platform === 'win32', 'finds the fake claude under the shell with pgrep')
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const cwd = stand.sessions[0]!.cwd
  const post = (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${stand.daemonURL}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  const shells = async () => ((await (await fetch(`${stand.daemonURL}/v1/shells`)).json()) as { shells?: { id: string; program?: string; agent_session_id?: string }[] }).shells ?? []
  const agent = `${stand.sessions[0]!.id.slice(0, 8)}-0000-4000-8000-5e11a9e00001`
  let fake = 0

  await app.open()
  // Its ready line is gone from alpha's screen once redraw.spec.ts has run
  // (CI, 2026-11-20): opened by its row then, as the other specs after it do.
  await app.openSession('alpha').catch(async () => { await app.row(stand.sessions[0]!.name).first().click() })
  const before = new Set((await shells()).map((s) => s.id))
  await app.chord('t')
  await expect.poll(async () => (await shells()).filter((s) => !before.has(s.id)).length).toBe(1)
  const shellId = (await shells()).find((s) => !before.has(s.id))!.id
  await expect(app.tabs.getByRole('tab', { name: /^Shell 1/, selected: true })).toBeVisible()
  // Typed through the daemon: the shell's prompt may not have focus yet.
  await expect.poll(async () => (await post(`/v1/agents/${shellId}/input`, { data: 'claude\r' })).status).toBe(204)
  await app.waitTerm(shellId, 'fake-claude ready')
  await expect.poll(async () => (await shells()).find((s) => s.id === shellId)?.program).toBe('claude')

  try {
    const { child_pid: shellPid } = JSON.parse(readFileSync(path.join(stand.dir, 'data', 'ptyhost', `${shellId}.json`), 'utf8')) as { child_pid: number }
    fake = Number(execFileSync('pgrep', ['-P', String(shellPid)], { encoding: 'utf8' }).trim().split('\n')[0])
    expect(fake, 'the fake claude runs under the shell').toBeGreaterThan(1)
    const { token } = JSON.parse(readFileSync(path.join(stand.dir, 'data', 'runtime.json'), 'utf8')) as { token: string }
    const hook = async (body: Record<string, unknown>) => {
      const res = await post('/v1/hook', { cwd, transcript_path: '', ...body }, { Authorization: `Bearer ${token}`, 'X-Caprock-Ppid': String(fake) })
      expect(res.status, `hook ${String(body.hook_event_name)}`).toBeLessThan(300)
    }
    await hook({ hook_event_name: 'SessionStart', session_id: agent, source: 'resume' })
    await hook({ hook_event_name: 'UserPromptSubmit', session_id: agent, prompt: 'Fix the login page', prompt_id: 'p-1' })
    await fetch(`${stand.daemonURL}/v1/sessions/${agent}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Fix the login page' }) })
    await expect.poll(async () => (await shells()).find((s) => s.id === shellId)?.agent_session_id, { timeout: 20_000 }).toBe(agent)

    // The inspector: the agent's cockpit, the shell named, the shell's actions.
    const inspector = page.getByRole('complementary', { name: 'Inspector' })
    await expect(app.tabs.getByRole('tab', { name: /^Fix the login page/, selected: true })).toBeVisible({ timeout: 20_000 })
    await expect(inspector.getByRole('heading', { level: 2 })).toHaveText('Agent')
    await expect(inspector.locator('[data-runs-in-shell]')).toContainText('Runs in Shell 1')
    const host = inspector.getByRole('region', { name: 'The shell: Shell 1' })
    await expect(host.getByRole('button', { name: 'Close the shell' })).toBeVisible()
    await expect(host.getByRole('button', { name: 'Stop the shell…' })).toBeVisible()
    await expect(inspector).not.toContainText('Login shell')
    if (shotsDir) {
      mkdirSync(shotsDir, { recursive: true })
      for (const t of ['dark', 'light'] as const) {
        await theme(page, t)
        await page.waitForTimeout(300)
        await inspector.evaluate((el) => { el.scrollTop = 0 })
        await inspector.screenshot({ path: path.join(shotsDir, `inspector-${t}.png`) })
        // Its foot: the shell's own section.
        await inspector.evaluate((el) => { el.scrollTop = el.scrollHeight })
        await inspector.screenshot({ path: path.join(shotsDir, `inspector-${t}-foot.png`) })
      }
      await inspector.evaluate((el) => { el.scrollTop = 0 })
      await theme(page, 'dark')
    }

    // The question: the session named, the processes listed, the keys.
    await page.locator('[data-dialog-backdrop]').waitFor({ state: 'detached' }).catch(() => {})
    await app.chord('w')
    const dialog = page.getByRole('dialog', { name: 'Close a running shell' })
    await expect(dialog).toContainText('“Fix the login page” is running in Shell 1. Close and stop it?')
    await expect(dialog.locator('[data-running-proc]').first()).toContainText('claude — “Fix the login page”', { timeout: 15_000 })
    const keep = dialog.getByRole('button', { name: /Keep running, close tab/ })
    await expect(keep).toBeFocused()
    if (shotsDir) {
      for (const t of ['dark', 'light'] as const) {
        await theme(page, t)
        await page.waitForTimeout(300)
        await dialog.screenshot({ path: path.join(shotsDir, `close-question-${t}.png`) })
      }
      await theme(page, 'dark')
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(app.tabs.getByRole('tab', { name: /^Fix the login page/ })).toBeVisible()

    // ⌘Enter (Ctrl+Enter off macOS) stops the shell and closes the tab.
    await app.chord('w')
    await expect(dialog).toBeVisible()
    const mac = await page.evaluate(() => /Mac|iP(hone|ad)/.test(navigator.platform || navigator.userAgent))
    await page.keyboard.press(mac ? 'Meta+Enter' : 'Control+Enter')
    await expect(dialog).toBeHidden()
    await expect.poll(async () => (await shells()).some((s) => s.id === shellId), { timeout: 15_000 }).toBe(false)
  } finally {
    // This stand started the fake claude in its own shell (rule 7).
    if (fake > 1) { try { process.kill(fake, 'SIGKILL') } catch { /* gone */ } }
  }
})
