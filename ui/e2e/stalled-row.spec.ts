/**
 * A stalled session in the sidebar (.ai/04-ui.md § Sidebar, *Stalled*),
 * against the sandboxed stand: a session the stand starts gets the
 * UserPromptSubmit hook Claude Code sends for a prompt and nothing after it.
 * The daemon lists it with `turn_open`; once the page's clock is 20 minutes
 * on, its row in *Running, no tab* wears the amber dot and says *no reply
 * 20m*, with what to do in its tooltip. The fake claude sends no hooks of
 * its own, so the one hook is posted here as the shim would.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, stopAgent, test } from './fixtures'

test('a turn with no reply for 15 minutes is marked on its sidebar row: amber dot, "no reply 20m"', async ({ app, page, stand }) => {
  const cwd = stand.sessions[1]!.cwd
  const post = (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${stand.daemonURL}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  const r = await post('/v1/agents', { cwd })
  const { session_id: id } = await r.json() as { session_id: string }
  expect(r.ok).toBe(true)
  try {
    const name = 'e2e stalled'
    await fetch(`${stand.daemonURL}/v1/sessions/${id}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
    const row = await (await fetch(`${stand.daemonURL}/v1/sessions/${id}`)).json() as { session?: { pid?: number }; pid?: number }
    const pid = row.session?.pid ?? row.pid
    const { token } = JSON.parse(readFileSync(path.join(stand.dir, 'data', 'runtime.json'), 'utf8')) as { token: string }
    const res = await post('/v1/hook', { cwd, transcript_path: '', hook_event_name: 'UserPromptSubmit', session_id: id, prompt: 'a request that never comes back', prompt_id: 'p-stall' },
      { Authorization: `Bearer ${token}`, 'X-Caprock-Ppid': String(pid) })
    expect(res.status).toBeLessThan(300)
    await expect.poll(async () => {
      const list = await (await fetch(`${stand.daemonURL}/v1/sessions?active=true`)).json() as { session_id: string; turn_open?: boolean }[]
      return list.find((s) => s.session_id === id)?.turn_open
    }, { message: 'the list says its turn is open' }).toBe(true)

    await page.clock.install()
    await app.open()
    const stalled = app.row(name).first()
    await expect(stalled).toBeVisible()
    await expect(stalled.locator('[data-stalled]')).toHaveCount(0)
    // Twenty minutes with no event: the row turns stalled on its own clock, with no new read.
    await page.clock.fastForward('20:00')
    await expect(stalled.locator('[data-stalled]')).toHaveText('no reply 20m')
    await expect(stalled.locator('[data-row-dot="stalled"]')).toBeVisible()
    await expect(stalled).toHaveAttribute('title', /Your last message got no reply\. Open it to send again\./)
    if (process.env.CAPROCK_E2E_SHOTS) await app.sidebar.screenshot({ path: path.join(process.env.CAPROCK_E2E_SHOTS, 'stalled-sidebar.png') })
    // A click opens it as any row does; its tab's row in Open says the same.
    await stalled.click()
    await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${name}`), selected: true })).toBeVisible()
    const open = app.sidebar.getByRole('group', { name: 'Open tabs' }).getByRole('button', { name: new RegExp(`\\b${name}\\b`) })
    await expect(open.locator('[data-stalled]')).toHaveText('no reply 20m')
    if (process.env.CAPROCK_E2E_SHOTS) await app.sidebar.screenshot({ path: path.join(process.env.CAPROCK_E2E_SHOTS, 'stalled-open-tab.png') })
  } finally {
    await page.close()
    await stopAgent(stand.daemonURL, id)
  }
})
