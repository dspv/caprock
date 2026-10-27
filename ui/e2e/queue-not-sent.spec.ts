/**
 * A message waiting in the queue outlives its session (ADR-053, amendment of
 * 2026-10-27), against the sandboxed stand: a session the stand starts is
 * mid-turn (its hooks posted here as the shim would — the fake claude sends
 * none), two messages are queued, the process is killed, and the chat shows
 * both as not sent. Send to a new session starts one in the same folder,
 * opens its chat with the message waiting, and once that session's
 * SessionStart arrives the message is typed into it. With QUEUE_SHOTS set,
 * the three states are saved there as PNGs.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures'

const shots = process.env.QUEUE_SHOTS

test('a queued message is kept as not sent when its session ends, and goes to a new session', async ({ page, stand }) => {
  const cwd = stand.sessions[0]!.cwd
  const post = (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${stand.daemonURL}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  const { token } = JSON.parse(readFileSync(path.join(stand.dir, 'data', 'runtime.json'), 'utf8')) as { token: string }
  const pidOf = async (id: string) => {
    const row = await (await fetch(`${stand.daemonURL}/v1/sessions/${id}`)).json() as { session?: { pid?: number }; pid?: number }
    return row.session?.pid ?? row.pid ?? 0
  }
  const hook = async (pid: number, body: Record<string, unknown>) => {
    const res = await post('/v1/hook', { cwd, transcript_path: '', ...body }, { Authorization: `Bearer ${token}`, 'X-Caprock-Ppid': String(pid) })
    expect(res.status, `hook ${String(body.hook_event_name)}`).toBeLessThan(300)
  }
  const started: string[] = []
  try {
    const r = await post('/v1/agents', { cwd })
    expect(r.ok).toBe(true)
    const { session_id: id } = await r.json() as { session_id: string }
    started.push(id)
    await fetch(`${stand.daemonURL}/v1/sessions/${id}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'e2e queue' }) })
    const pid = await pidOf(id)
    expect(pid, 'the spawned session has a pid').toBeGreaterThan(1)

    // Mid-turn: what is sent now is held.
    await hook(pid, { hook_event_name: 'SessionStart', session_id: id, source: 'startup' })
    await hook(pid, { hook_event_name: 'UserPromptSubmit', session_id: id, prompt: 'Refactor the parser', prompt_id: 'p1' })
    for (const text of ['Then run the tests and commit', 'And open a pull request']) {
      const q = await (await post(`/v1/agents/${id}/queue`, { text })).json() as { sent: boolean }
      expect(q.sent, `${text} is queued`).toBe(false)
    }

    // The process ends.
    expect((await post(`/v1/agents/${id}/signal`, { action: 'kill' })).status).toBe(204)
    await expect.poll(async () => {
      const v = await (await fetch(`${stand.daemonURL}/v1/agents/${id}/queue`)).json() as { messages: unknown[]; undelivered?: unknown[] }
      return `${v.messages.length} ${v.undelivered?.length ?? 0}`
    }).toBe('0 2')

    await page.goto(`${stand.pageURL}/#/session/${encodeURIComponent(id)}?tab=chat`)
    const chat = page.locator('[data-chat-view]')
    await expect(chat.getByText('Not sent: the session ended')).toHaveCount(2)
    await expect(chat.getByRole('button', { name: 'Send all 2 to a new session' })).toBeVisible()
    await expect(chat.getByRole('button', { name: 'Copy the message: Then run the tests and commit' })).toBeVisible()
    if (shots) await page.screenshot({ path: path.join(shots, '1-not-sent.png') })

    // Send the first one on: a new session in the same folder, its chat opened.
    await chat.getByRole('button', { name: 'Send to a new session: Then run the tests and commit' }).click()
    await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).not.toContain(id)
    const next = /#\/session\/([^?]+)/.exec(decodeURIComponent(new URL(page.url()).hash))?.[1] ?? ''
    expect(next).not.toBe('')
    started.push(next)
    const nextChat = page.locator('[data-chat-view]')
    await expect(nextChat.locator('[data-queued-id]').getByText('Then run the tests and commit')).toBeVisible()
    await expect(nextChat.getByText('Sends once the new session has started')).toBeVisible()
    if (shots) await page.screenshot({ path: path.join(shots, '2-waiting-in-the-new-session.png') })

    // The new session starts: the message goes in through its queue.
    const pid2 = await pidOf(next)
    expect(pid2).toBeGreaterThan(1)
    await hook(pid2, { hook_event_name: 'SessionStart', session_id: next, source: 'startup' })
    await expect.poll(async () => {
      const v = await (await fetch(`${stand.daemonURL}/v1/agents/${next}/queue`)).json() as { messages: unknown[] }
      return v.messages.length
    }).toBe(0)
    // As Claude Code records the prompt it was typed in as.
    await hook(pid2, { hook_event_name: 'UserPromptSubmit', session_id: next, prompt: 'Then run the tests and commit', prompt_id: 'p2' })
    await expect(nextChat.locator('[data-queued-id]')).toHaveCount(0)
    await expect(nextChat.getByText('Then run the tests and commit')).toBeVisible()
    if (shots) await page.screenshot({ path: path.join(shots, '3-delivered.png') })

    // The other one is still kept on the ended session.
    const left = await (await fetch(`${stand.daemonURL}/v1/agents/${id}/queue`)).json() as { undelivered?: { text: string }[] }
    expect(left.undelivered?.map((m) => m.text)).toEqual(['And open a pull request'])
  } finally {
    // This stand started them, so this stand stops them (rule 7).
    for (const s of started) await post(`/v1/agents/${s}/signal`, { action: 'kill' })
  }
})
