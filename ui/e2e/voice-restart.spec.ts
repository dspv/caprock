/**
 * The voice restart strip (lib/termvoice.ts, .ai/04-ui.md § Voice after the
 * helper), against the sandboxed stand: a Claude Code session Caprock started
 * prints Claude Code's voice failure line, its tab shows *Voice works after
 * restarting this session.* with *Restart here*, and the press ends the fake
 * claude and starts it again with `--resume <id>` in the same folder — the
 * same tab, in the same place, under the same title, its terminal attached
 * to the new process. The strip is for a daemon on macOS only: the stand may
 * run on Linux (CI), so the page is told the daemon's platform is macOS.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, stopAgent, test } from './fixtures'

test('Restart here resumes the same conversation in the same tab', async ({ app, page, stand }) => {
  const cwd = stand.sessions[0]!.cwd
  const post = (p: string, body: unknown) => fetch(`${stand.daemonURL}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const r = await post('/v1/agents', { cwd })
  const { session_id: id } = await r.json() as { session_id: string }
  expect(r.ok).toBe(true)
  const name = 'e2e voice'
  await fetch(`${stand.daemonURL}/v1/sessions/${id}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
  // The daemon on macOS, whatever this stand runs on.
  await page.route(/\/v1\/status$/, async (route) => {
    const res = await route.fetch()
    const body = await res.json() as Record<string, unknown>
    await route.fulfill({ response: res, json: { ...body, platform: 'darwin/arm64' } })
  })
  try {
    await app.open()
    await app.row(name).first().click()
    const tab = app.tabs.getByRole('tab', { name: new RegExp(`^${name}`), selected: true })
    await expect(tab).toBeVisible()
    await app.waitTerm(id, 'fake-claude ready')
    const before = await app.tabs.getByRole('tab').allTextContents()
    const at = before.findIndex((t) => t.startsWith(name))
    expect(at).toBeGreaterThanOrEqual(0)
    const pid = /fake-claude ready pid=(\d+)/.exec(await app.termText(id))?.[1]
    expect(pid).toBeTruthy()

    const strip = page.locator('[data-voice-restart]')
    await expect(strip).toHaveCount(0)
    expect((await post(`/v1/agents/${id}/input`, { data: 'voice-silent\r' })).status).toBe(204)
    await expect(strip).toBeVisible()
    await expect(strip).toContainText('Voice works after restarting this session.')
    await strip.getByRole('button', { name: 'Restart here' }).click()
    await expect(strip).toHaveCount(0)

    // A new process on the same id, in this tab's terminal.
    await expect.poll(async () => {
      const m = [...(await app.termText(id)).matchAll(/fake-claude ready pid=(\d+)/g)].map((x) => x[1])
      return m.some((p) => p !== pid)
    }, { message: 'the terminal shows the new process' }).toBe(true)
    expect((await post(`/v1/agents/${id}/input`, { data: 'argv\r' })).status).toBe(204)
    await app.waitTerm(id, `argv:--resume ${id}`)

    // Same session, same folder, same tab in the same place under the same title.
    const s = await (await fetch(`${stand.daemonURL}/v1/sessions/${id}`)).json() as { session?: { cwd?: string; status?: string; owned?: boolean }; cwd?: string; status?: string; owned?: boolean }
    const row = s.session ?? s
    expect(row.cwd).toBe(cwd)
    expect(row.status).not.toBe('ended')
    expect(row.owned).toBe(true)
    await expect(tab).toBeVisible()
    const after = await app.tabs.getByRole('tab').allTextContents()
    expect(after).toHaveLength(before.length)
    expect(after.findIndex((t) => t.startsWith(name))).toBe(at)
    await expect.poll(() => { try { return readFileSync(path.join(stand.dir, 'data', 'open-tabs.json'), 'utf8') } catch { return '' } }).toContain(id)

    // Dismissed, or restarted from: not offered again for this session.
    expect((await post(`/v1/agents/${id}/input`, { data: 'voice-denied\r' })).status).toBe(204)
    await app.waitTerm(id, 'Microphone access is denied')
    await page.waitForTimeout(1200)
    await expect(strip).toHaveCount(0)
  } finally {
    await page.close()
    await stopAgent(stand.daemonURL, id)
  }
})
