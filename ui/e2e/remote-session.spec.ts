/**
 * A session on another computer is a tab like one of this machine's (issue
 * #1085; owner, 2026-11-28): its row under Computers opens it in the strip,
 * tagged with the computer's name and the folder it runs in, listed under
 * Open with the same tag — and the tab is the local tab's own component tree
 * (components/MachineTab.tsx): the terminal pane first, the Chat/Terminal
 * switch in the strip, the agent cockpit beside it, laid out where a local
 * tab has them, read from that computer through `/v1/m/<id>/…`. No phone
 * key row (Esc Tab ↑ ↓ ↵ Ctrl+C) on a desktop, and the dashboard's Session
 * view is not what it shows.
 *
 * The other computer is answered at the page: its session list, the
 * session's detail and its events are made up here; whatever else the tab
 * asks of it goes to the stand's own daemon, so its answers have the real
 * shapes. Its live socket and terminal are accepted and stay quiet. Nothing
 * reaches a relay.
 *
 * With CAPROCK_SHOTS_DIR set it photographs a local tab and the remote one.
 */
import path from 'node:path'
import type { FrameLocator, Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''
const WIN = 'winPC1000000000000000000000000000000000000AB'
const TITLE = 'Port the hook shim to Windows paths'

const json = (b: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(b) })

async function answerWindowsPC(page: Page, sid: string) {
  const now = Date.now()
  const summary = {
    session_id: sid, title: TITLE, cwd: 'C:\\Users\\me\\dev\\caprock', project: 'caprock', status: 'active', agent: 'claude', owned: true,
    model: 'claude-opus-5-5', started_at: now - 20 * 60_000, last_event_at: now - 30_000, has_hooks: true, has_transcript: true,
    activity: { health: 'idle', phrase: 'idle', at: new Date(now - 30_000).toISOString() },
    stats: { session_id: sid, turns: 14, tool_calls: 37, files_touched: 6, cost_usd: 2.41, tokens_in: 18_400, tokens_out: 9_200, cache_read: 1_240_000, cache_write: 86_000 },
  }
  const at = (min: number) => new Date(now - min * 60_000).toISOString()
  const events = [
    { id: 1, ts: at(19), session_id: sid, source: 'hook', kind: 'turn.user', payload: { prompt: 'The PC shows no cost for the session it started. Find out why.' } },
    { id: 2, ts: at(18), session_id: sid, source: 'transcript', kind: 'turn.assistant', payload: { text: 'The hook names the transcript as C:\\Users\\me\\.claude\\projects\\C--Users-me-dev-caprock\\…, and the daemon walks another folder. I will follow the path the hook gives.' } },
    { id: 3, ts: at(2), session_id: sid, source: 'hook', kind: 'turn.user', payload: { prompt: 'Good. Add a test with Windows paths.' } },
    { id: 4, ts: at(1), session_id: sid, source: 'transcript', kind: 'turn.assistant', payload: { text: 'Done: the test compares C:\\Users\\Me and c:/users/me as one file, and the session now counts its turns.' } },
  ]
  await page.route(/\/v1\/machines(\?.*)?$/, (r) => r.request().method() === 'GET'
    ? r.fulfill(json({ machines: [{ id: WIN, name: 'Win PC1', relay: 'wss://relay.invalid', added_at: now, status: 'online', kind: 'machine', role: 'controller', version: '0.197.0', last_seen: now, streams: 0 }] }))
    : r.fallback())
  await page.route(/\/v1\/machines\/sessions$/, (r) => r.fulfill(json({ machines: [{ id: WIN, name: 'Win PC1', status: 'online', at: now, sessions: [summary] }] })))
  await page.route(/\/v1\/m\/[^/]+\//, (r) => {
    const u = new URL(r.request().url())
    const own = u.pathname.replace(/^\/v1\/m\/[^/]+/, '')
    if (own === `/v1/sessions/${sid}`) return r.fulfill(json({ ...summary, files: [], events }))
    if (own === `/v1/sessions/${sid}/events`) return r.fulfill(json(u.searchParams.has('before') ? [] : events))
    if (own === '/v1/sessions') return r.fulfill(json([summary]))
    if (own === '/v1/setup') return r.fulfill(json({ os: 'windows', items: [], agents: [] }))
    // Anything else the tab asks of it, the stand's own daemon answers.
    u.pathname = own
    return r.continue({ url: u.toString() })
  })
  // Its live socket and terminal: accepted, quiet.
  await page.routeWebSocket(/\/v1\/m\//, () => {})
}

/** A box on the page (Playwright measures one inside the frame on the page too). */
async function box(l: Locator) {
  const b = await l.boundingBox()
  if (!b) throw new Error('no box')
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
}

function near(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, what: string) {
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(a[k] - b[k]), `${what}: ${k} ${a[k]} vs ${b[k]}`).toBeLessThanOrEqual(2)
}

test('a session on another computer opens in the same tab as a local one: terminal pane, switch, cockpit, no phone keys', async ({ app, page }) => {
  test.setTimeout(90_000)
  const sid = app.session('alpha').id
  await answerWindowsPC(page, sid)
  await page.setViewportSize({ width: 1440, height: 900 })
  await app.open()

  // A local tab first, as the yardstick: its terminal pane and its cockpit.
  // Only its layout is measured, so its terminal's text is not waited on: a
  // spec in the other worker may hold the same fake session.
  const beta = app.session('beta')
  await app.row(beta.name).first().click()
  await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${beta.name}`), selected: true })).toBeVisible()
  const localPanel = page.locator('[data-tab-panel]:visible').first()
  const localInspector = page.getByRole('complementary', { name: 'Inspector' })
  await expect(localInspector).toBeVisible()
  await expect(page.locator('[data-view-switch]')).toBeVisible()
  const localPanelBox = await box(localPanel)
  const localInspectorBox = await box(localInspector)
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'local-tab.png') })

  // Under Computers, the PC's running session: a click opens a tab.
  await page.locator(`[data-machine-session-row="${sid}"]`).click()
  const tab = app.tabs.locator('[data-remote-tab]')
  await expect(tab).toHaveCount(1)
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(tab.locator('[data-row-title]')).toHaveText(TITLE)
  await expect(tab.locator('[data-machine-tag]')).toHaveText('Win PC1')
  // Where it works there, as a project names a tab here.
  await expect(tab).toContainText('caprock')

  // Under Open, with the same tag and its folder.
  const open = page.locator('[data-open-section] [data-remote-row]')
  await expect(open).toHaveCount(1)
  await expect(open.locator('[data-row-title]')).toHaveText(TITLE)
  await expect(open.locator('[data-machine-tag]')).toHaveText('Win PC1')

  // The tab is the local tab's tree, in a frame read through the proxy.
  const frame: FrameLocator = page.frameLocator('[data-remote-pane] iframe')
  await expect(frame.locator(`[data-machine-tab="${sid}"]`)).toBeVisible()
  const remotePanel = frame.locator('[data-tab-panel]').first()
  await expect(remotePanel.locator(`[data-term-host][data-term-session="${sid}"]`)).toBeAttached()
  const remoteInspector = frame.getByRole('complementary', { name: 'Inspector' })
  await expect(remoteInspector).toBeVisible()
  await expect(remoteInspector).toContainText('$2.41')
  // Not the dashboard's Session view, and no phone key row on a desktop.
  await expect(frame.getByRole('group', { name: 'Keys' })).toHaveCount(0)
  await expect(frame.getByText(/Nothing measured yet/)).toHaveCount(0)
  await expect(frame.getByRole('tab', { name: 'Timeline' })).toHaveCount(0)
  // This window's inspector is not drawn beside it; the strip's switch is.
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeHidden()
  await expect(page.locator('[data-view-switch]')).toBeVisible()

  // Laid out where a local tab is: the pane and the cockpit in the same places.
  near(await box(remotePanel), localPanelBox, 'pane')
  near(await box(remoteInspector), localInspectorBox, 'inspector')
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'remote-tab.png') })

  // The strip's switch shows its chat, with no key row; and back.
  await page.locator('[data-view-switch]').click()
  await expect(frame.getByRole('log', { name: 'Conversation' })).toContainText('the session now counts its turns')
  await expect(frame.getByRole('group', { name: 'Keys' })).toHaveCount(0)
  await page.locator('[data-view-switch]').click()
  await expect(frame.getByRole('log', { name: 'Conversation' })).toHaveCount(0)

  // An app key pressed while the frame has the keyboard is this window's: ⌘I.
  await remotePanel.click()
  await app.chord('i')
  await expect(remoteInspector).toBeHidden()
  await app.chord('i')
  await expect(remoteInspector).toBeVisible()

  // The cockpit's Dashboard shows that computer's Session view over the tab, with a way back.
  await remoteInspector.getByRole('link', { name: 'Open in the dashboard' }).click()
  await expect(frame.getByRole('button', { name: /Back to the tab/ })).toBeVisible()
  await frame.getByRole('button', { name: /Back to the tab/ }).click()
  await expect(frame.locator('[data-machine-tab-page]')).toHaveCount(0)
  await expect(remotePanel).toBeVisible()

  // Opening it again brings the same tab forward; its × closes it, the
  // session runs on there, and Recently closed brings it back.
  await page.locator(`[data-machine-session-row="${sid}"]`).click()
  await expect(app.tabs.locator('[data-remote-tab]')).toHaveCount(1)
  await tab.hover()
  await tab.getByRole('button', { name: /^Close/ }).click()
  await expect(app.tabs.locator('[data-remote-tab]')).toHaveCount(0)
  const closed = page.locator(`[data-closed-row="m:${WIN}/${sid}"]`)
  if (!(await closed.isVisible())) await page.getByRole('button', { name: /Recently closed/ }).click()
  await expect(closed.locator('[data-machine-tag]')).toHaveText('Win PC1')
  await closed.click()
  await expect(app.tabs.locator('[data-remote-tab]')).toHaveCount(1)
  await app.tabs.locator('[data-remote-tab]').hover()
  await app.tabs.locator('[data-remote-tab]').getByRole('button', { name: /^Close/ }).click()
})
