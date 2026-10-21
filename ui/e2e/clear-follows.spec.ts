/**
 * A tab after /clear (.ai/04-ui.md § One card per conversation), against the
 * sandboxed stand: a session the stand starts gets the hooks Claude Code
 * sends for a /clear — the old id's SessionEnd, then a SessionStart with a
 * new id and source "clear", from the same process — and the open tab moves
 * to the new id with its terminal, its chat shows the part before the clear
 * above the divider, and the new id takes input. The fake claude sends no
 * hooks of its own, so they are posted here as the shim would.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures'

test('after /clear the tab follows the new session: terminal, chat with the earlier part, and input', async ({ app, page, stand }) => {
  const cwd = stand.sessions[0]!.cwd
  const post = (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${stand.daemonURL}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  const r = await post('/v1/agents', { cwd })
  const { session_id: spawn } = await r.json() as { session_id: string }
  expect(r.ok).toBe(true)
  const name = 'e2e cleared'
  await fetch(`${stand.daemonURL}/v1/sessions/${spawn}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
  const row = await (await fetch(`${stand.daemonURL}/v1/sessions/${spawn}`)).json() as { session?: { pid?: number }; pid?: number }
  const pid = row.session?.pid ?? row.pid
  expect(pid, 'the spawned session has a pid').toBeGreaterThan(1)
  const next = `${spawn.slice(0, 8)}-0000-4000-8000-c1ea7ed00001`
  try {
    const { token } = JSON.parse(readFileSync(path.join(stand.dir, 'data', 'runtime.json'), 'utf8')) as { token: string }
    const hook = async (body: Record<string, unknown>) => {
      const res = await post('/v1/hook', { cwd, transcript_path: '', ...body }, { Authorization: `Bearer ${token}`, 'X-Caprock-Ppid': String(pid) })
      expect(res.status, `hook ${String(body.hook_event_name)}`).toBeLessThan(300)
    }

    await app.open()
    await app.row(name).first().click()
    await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${name}`), selected: true })).toBeVisible()
    await app.waitTerm(spawn, 'fake-claude ready')

    await hook({ hook_event_name: 'UserPromptSubmit', session_id: spawn, prompt: 'words from before the clear', prompt_id: 'p-before' })
    await hook({ hook_event_name: 'SessionEnd', session_id: spawn, reason: 'clear' })
    await hook({ hook_event_name: 'SessionStart', session_id: next, source: 'clear' })
    await hook({ hook_event_name: 'UserPromptSubmit', session_id: next, prompt: 'words from after the clear', prompt_id: 'p-after' })

    // The daemon: the new id is Caprock's, held, and takes input.
    await expect.poll(async () => {
      const s = await (await fetch(`${stand.daemonURL}/v1/sessions/${next}`)).json() as { session?: { owned?: boolean; status?: string }; owned?: boolean; status?: string; detached?: boolean }
      const x = s.session ?? s
      return `${String(x.owned)} ${String(x.status)} ${String(s.detached ?? false)}`
    }).toBe('true active false')
    expect((await post(`/v1/agents/${next}/input`, { data: '' })).status).toBe(204)

    // The tab: reported under the new id, its terminal attached under it.
    await expect.poll(() => { try { return readFileSync(path.join(stand.dir, 'data', 'open-tabs.json'), 'utf8') } catch { return '' } }).toContain(next)
    await app.waitTerm(next, 'fake-claude ready')
    await expect(app.tabs.getByRole('tab', { selected: true })).toHaveCount(1)

    // The chat: the earlier part above the divider, the new part under it, and the field.
    const icon = page.locator('[data-view-switch]')
    await icon.click()
    const chat = page.locator('[data-chat-view]')
    await expect(chat).toBeVisible()
    await expect(chat.getByText('words from before the clear')).toBeVisible()
    await expect(chat.getByText('words from after the clear')).toBeVisible()
    await expect(chat.locator('[data-cleared-divider]')).toHaveText('Context cleared — Claude no longer remembers the part above')
    await expect(chat.getByRole('textbox')).toBeVisible()
    await icon.click()

    // Stopped through the new id, the process ends both.
    expect((await post(`/v1/agents/${next}/signal`, { action: 'kill' })).status).toBe(204)
    await expect.poll(async () => {
      const s = await (await fetch(`${stand.daemonURL}/v1/sessions/${next}`)).json() as { session?: { status?: string }; status?: string }
      return (s.session ?? s).status
    }).toBe('ended')
  } finally {
    // This stand started it, so this stand stops it (rule 7), leaving the
    // stand's two sessions the only ones running for the specs after this.
    await post(`/v1/agents/${spawn}/signal`, { action: 'kill' })
  }
})
