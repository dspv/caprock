/**
 * Set up a linked computer from this one (issue #1088, variant A of the
 * mockup the owner picked on 2026-11-26): the Windows PC's page lists what it
 * still needs, and each step runs there on its click only — Node.js installs
 * with the last line it printed, the GitHub sign-in shows its one-time code
 * with Copy and open, Claude Code's bypass warning is read and accepted here,
 * and the steps of its own screen are marked done by hand. The sidebar says
 * how many are left.
 *
 * The computer is answered at the page: nothing reaches a relay, nothing is
 * installed, and the shared stand's settings are never written.
 *
 * With CAPROCK_SHOTS_DIR set it photographs the section, light and dark.
 */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''
const WIN = 'winPC1000000000000000000000000000000000000AB'
const json = (b: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(b) })

type Tool = { id: string; label: string; state: string; detail: string; command?: string }

async function shoot(page: Page, name: string) {
  if (!shotsDir) return
  for (const theme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await page.waitForTimeout(150)
    await page.screenshot({ path: path.join(shotsDir, `remote-setup-${name}-${theme}.png`) })
  }
}

test('A linked Windows PC is set up from its page, each step run there on its click', async ({ app, page }) => {
  test.setTimeout(60_000)
  const now = Date.now()
  let setupDone: string[] = ['site_sign_ins']
  const machines = () => [{ id: WIN, name: 'Win PC1', relay: 'wss://relay.invalid', added_at: now, status: 'online', kind: 'machine', role: 'controller', version: '0.198.0', last_seen: now, streams: 0, setup_done: setupDone }]
  const tools: Tool[] = [
    { id: 'node', label: 'Node.js', state: 'missing', detail: 'npm and the agents installed with it use it. Install runs winget there; Windows may ask for an administrator on that PC\'s own screen.', command: 'winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements' },
    { id: 'gh', label: 'GitHub CLI', state: 'ok', detail: 'Installed.' },
    { id: 'gh_auth', label: 'Sign in to GitHub', state: 'missing', detail: 'By a one-time code you enter on GitHub from this computer; Git there uses the same sign-in.', command: 'gh auth login --web --hostname github.com --git-protocol https' },
    { id: 'bypass', label: 'Bypass warning', state: 'missing', detail: 'Claude Code asks once before its first session in Bypass; accept it here so a start from this computer is not stopped there.' },
    { id: 'chrome_default', label: 'Claude in Chrome on by default', state: 'missing', detail: 'Claude Code\'s /chrome setting "Enabled by default": sessions there connect to Chrome when they start.' },
  ]
  const setup = () => ({
    os: 'windows',
    items: [
      { key: 'git', state: 'ok', label: 'Git', detail: 'Installed.' },
      { key: 'agent', state: 'ok', label: 'Agents', detail: 'Claude Code ready.' },
      { key: 'link', state: 'ok', label: 'Link to your laptop', detail: 'MacBook can start agents here.' },
      { key: 'project', state: 'ok', label: 'Projects here', detail: '2 projects.', optional: true },
    ],
    agents: [{ id: 'claude', label: 'Claude Code', on: true, state: 'ok', detail: 'Signed in. Ready.' }],
    tools,
  })
  const runs: Record<string, unknown> = {}
  const asked: string[] = []

  await page.route(/\/v1\/machines(\?.*)?$/, (r) => r.request().method() === 'GET' ? r.fulfill(json({ machines: machines() })) : r.fallback())
  await page.route(/\/v1\/machines\/[^/]+$/, (r) => {
    if (r.request().method() !== 'PATCH') return r.fallback()
    setupDone = (r.request().postDataJSON() as { setup_done: string[] }).setup_done
    asked.push(`PATCH machine ${setupDone.join(',')}`)
    return r.fulfill(json(machines()[0]))
  })
  await page.route(/\/v1\/machines\/sessions$/, (r) => r.fulfill(json({ machines: [{ id: WIN, name: 'Win PC1', status: 'online', at: now, sessions: [] }] })))
  await page.route(/\/v1\/m\/[^/]+\//, (r) => {
    const u = new URL(r.request().url())
    const p = u.pathname.replace(/^\/v1\/m\/[^/]+/, '')
    const method = r.request().method()
    if (p === '/v1/setup') return r.fulfill(json(setup()))
    if (p === '/v1/setup/runs') return r.fulfill(json({ runs: Object.values(runs) }))
    if (p === '/v1/setup/run' && method === 'POST') {
      const { step } = r.request().postDataJSON() as { step: string }
      asked.push(`run ${step}`)
      if (step === 'node') runs.node = { key: 'node', step: 'node', shell: 'sh-node', state: 'running', line: 'Downloading https://nodejs.org/dist/v24.12.0/node-v24.12.0-x64.msi  ██████████▌  42%', started_at: now }
      if (step === 'gh_auth') runs.gh_auth = { key: 'gh_auth', step: 'gh_auth', shell: 'sh-gh', state: 'running', line: 'Press Enter to open github.com in your browser...', code: 'A1B2-C3D4', started_at: now }
      return r.fulfill(json(runs[step]))
    }
    if (p === '/v1/claude/bypass-consent' && method === 'POST') {
      asked.push('consent')
      tools.find((t) => t.id === 'bypass')!.state = 'ok'
      return r.fulfill(json({ accepted: true }))
    }
    if (p === '/v1/status') return r.fulfill(json({ version: '0.198.0', claude_bypass_accepted: tools.find((t) => t.id === 'bypass')!.state === 'ok' }))
    if (p === '/v1/resources') return r.fulfill(json({ at: now, sessions: [], machine: { cpus: 16, mem_total: 32 * 2 ** 30, mem_available: 18 * 2 ** 30 } }))
    if (p === '/v1/sessions') return r.fulfill(json([]))
    if (p === '/v1/saved-prompts') return r.fulfill(json({ items: [], max: 50 }))
    if (p === '/v1/shells') return r.fulfill(json({ shells: [{ id: 'sh-node', cwd: 'C:\\Users\\me', command: 'pwsh', started_at: now, survives_restart: true, internal: true, kind: 'shell', program: 'winget' }] }))
    // Anything else the shell's view reads, the stand's own daemon answers;
    // nothing else is written.
    if (method !== 'GET') return r.fulfill(json({ error: 'not in this test' }, 404))
    u.pathname = p
    return r.continue({ url: u.toString() })
  })
  // Its live socket and the shell's terminal: accepted, quiet.
  await page.routeWebSocket(/\/v1\/m\//, () => {})
  await page.setViewportSize({ width: 1440, height: 900 })
  await app.open()

  // The sidebar says how many are left: Node, the sign-in, the warning, Chrome, the extension.
  const row = page.locator(`[data-machine-rows] [data-machine-row="${WIN}"]`)
  await expect(row.locator('[data-machine-row-setup]')).toHaveText('5 to set up')
  await row.locator('button').first().click()

  const section = page.getByRole('region', { name: 'Set up this computer' })
  await expect(section.locator('[data-remote-setup-count]')).toHaveText('4 of 9 done · each step runs there when you click it')
  expect(asked).toEqual([])
  await shoot(page, 'page')

  // Node.js: runs there on the click, the row says the last line.
  const node = section.locator('[data-remote-step="node"]')
  await node.getByRole('button', { name: 'Install' }).click()
  await expect(node).toHaveAttribute('data-mark', 'running')
  await expect(node.locator('[data-remote-step-detail]')).toContainText('42%')

  // GitHub: the one-time code, here.
  const gh = section.locator('[data-remote-step="gh_auth"]')
  await gh.getByRole('button', { name: 'Sign in' }).click()
  await expect(gh.locator('[data-device-code-value]')).toHaveText('A1B2-C3D4')
  await expect(gh.getByRole('button', { name: 'Copy and open' })).toBeVisible()
  expect(asked).toEqual(['run node', 'run gh_auth'])
  await section.scrollIntoViewIfNeeded()
  await shoot(page, 'running')

  // The bypass warning, read here and accepted there.
  const bypass = section.locator('[data-remote-step="bypass"]')
  await bypass.getByRole('button', { name: 'Read and accept' }).click()
  await expect(bypass.getByRole('note', { name: 'Bypass consent' })).toContainText('First bypass session on Win PC1')
  await shoot(page, 'bypass')
  await bypass.getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(bypass).toHaveAttribute('data-mark', 'done')

  // Its own screen: marked done here.
  const ext = section.locator('[data-remote-step="chrome_extension"]')
  await ext.getByRole('button', { name: 'Done there' }).click()
  await expect.poll(() => asked).toContain('PATCH machine site_sign_ins,chrome_extension')

  // Show output: the shell there, in a tab of its own.
  await node.getByRole('button', { name: 'Show output' }).click()
  await expect(page.locator('[data-remote-tab]').filter({ hasText: 'Node.js on Win PC1' })).toBeVisible()
  await expect(page.frameLocator('[data-remote-pane="sh-node"] iframe').locator('[data-machine-shell="sh-node"]')).toBeAttached()
})
