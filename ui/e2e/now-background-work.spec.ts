/**
 * Now while the turn waits on background work (owner, 2026-11-24,
 * translated: "it looks like work stopped and I don't understand what's
 * happening"): the cockpit said *Done* and *Subagents · 1 done* while the
 * lead waited on a background subagent and a background release script.
 * The fake claude starts no background work, so the session's background
 * state and its subagents are stubbed at the page, in the shapes the daemon
 * sends (`background_work`, `activity.background_tasks`); nothing is typed
 * into the fake claude.
 */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
const now = Date.now()
const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''

// The agent stopped to wait on its own e2e run: its SubagentStop fired, and
// the daemon still lists it working because Claude Code has not said its end.
const SUBS = {
  working: [
    { agent_id: 'ad2f45955863f7dd0', agent_type: 'general-purpose', description: 'Checks popover clipped at bottom', tool_calls: 14, started_at: now - 400_000, last_at: now - 120_000, tool: 'Bash', detail: 'Run the full e2e suite', tool_at: now - 130_000, running: false, asking: false, cost_usd: 2.4 },
  ],
  finished: 0,
  recent: [],
  cost_usd: 2.4,
}

async function stub(page: Page, sessionId: string) {
  await page.route(/\/v1\/sessions\/[^/]+\/subagents(\?.*)?$/, (r) => r.fulfill(json(SUBS)))
  await page.route(/\/v1\/sessions(\?.*)?$/, async (r) => {
    const res = await r.fetch()
    const rows = await res.json() as Record<string, unknown>[]
    for (const s of Array.isArray(rows) ? rows : []) {
      if (s.session_id !== sessionId) continue
      s.activity = { phrase: 'waiting on background work · 1 agent, 1 shell', at: new Date(now - 60_000).toISOString(), health: 'working', background: 1, background_tasks: 1 }
      s.live_subagents = 1
      s.background_work = [
        { kind: 'agent', id: 'ad2f45955863f7dd0', description: 'Checks popover clipped at bottom', started_at: now - 400_000 },
        { kind: 'shell', id: 'bja8lc5fk', description: 'Restart chain: merge #1045, release 0.192.0', command: '/tmp/rel0192b.sh', started_at: now - 2_820_000 },
      ]
    }
    await r.fulfill({ response: res, json: rows })
  })
}

test('Now says what the turn waits on in the background, not Done', async ({ app, page }) => {
  const alpha = app.session('alpha')
  await stub(page, alpha.id)
  await app.open()
  await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const now_ = inspector.getByRole('region', { name: 'Now' })

  await expect(now_.getByText('Waiting on background work · 1 agent, 1 shell')).toBeVisible()
  await expect(now_.getByText('resumes when they finish')).toHaveCount(1)
  await expect(now_.getByText(/^Done$/)).toHaveCount(0)
  await expect(inspector.getByRole('status').first()).toHaveAttribute('aria-label', 'Waiting on background work · 1 agent, 1 shell')

  // The release script, with how long it has run; the agent is the tree's.
  const work = now_.getByRole('list', { name: 'Background work' })
  await expect(work.getByRole('listitem')).toHaveCount(1)
  await expect(work.getByRole('listitem').first()).toHaveAttribute('data-kind', 'shell')
  await expect(work).toContainText('Restart chain: merge #1045, release 0.192.0')
  await expect(work).toContainText(/4[78]m \d\ds/)
  const head = now_.locator('[data-agents-head]')
  await expect(head).toContainText('Background agents · 1')
  await expect(head).not.toContainText('done')
  await expect(now_.locator('[data-subagent="ad2f45955863f7dd0"]')).toContainText('Checks popover clipped at bottom')
  // With CAPROCK_SHOTS_DIR set, the PR's own photograph of it (not a test).
  if (shotsDir) await now_.screenshot({ path: path.join(shotsDir, 'now-background-work.png') })

  // Nothing reaches past the inspector at its narrowest.
  await page.evaluate(() => document.documentElement.style.setProperty('--app-inspector-w', '280px'))
  await page.waitForTimeout(150)
  const over = await now_.evaluate((sec) => {
    const edge = sec.getBoundingClientRect().right + 0.5
    return [...sec.querySelectorAll<HTMLElement>('button, li, ul')].filter((el) => el.offsetWidth > 0 && el.getBoundingClientRect().right > edge).map((el) => el.textContent)
  })
  expect(over).toEqual([])
  await page.evaluate(() => document.documentElement.style.removeProperty('--app-inspector-w'))
})
