/**
 * A reply that lands after its Stop (owner's Chat, 2026-11-26), against the
 * sandboxed stand. Claude Code sends the Stop hook before the transcript
 * tailer reads the reply, so the reply's row is stored after the Stop with an
 * earlier time; and Claude Code writes the reply as a thinking line, then a
 * text line with the same message id, read in one pass. The chat showed the
 * prompt and no answer. Here the hooks are posted as the shim would (the fake
 * claude sends none) and the two transcript lines are written into the
 * stand's own HOME, after the Stop: the answer shows live, and again after a
 * reload.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, stopAgent, test } from './fixtures'

test('a reply stored after its Stop shows in the chat, live and after a reload', async ({ app, page, stand }) => {
  const cwd = stand.sessions[0]!.cwd
  const post = (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${stand.daemonURL}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  const r = await post('/v1/agents', { cwd })
  expect(r.ok).toBe(true)
  const { session_id: id } = await r.json() as { session_id: string }
  const name = 'e2e late reply'
  await fetch(`${stand.daemonURL}/v1/sessions/${id}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
  const row = await (await fetch(`${stand.daemonURL}/v1/sessions/${id}`)).json() as { session?: { pid?: number }; pid?: number }
  const pid = row.session?.pid ?? row.pid
  expect(pid, 'the spawned session has a pid').toBeGreaterThan(1)
  const dir = path.join(stand.dir, 'home', '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  const transcript = path.join(dir, `${id}.jsonl`)
  const answer = 'Ναι — the promo code cannot be generated here.'
  // The file exists before anything is written to it, as Claude Code's does:
  // each write after this one wakes the tailer.
  mkdirSync(dir, { recursive: true })
  writeFileSync(transcript, '')
  try {
    const { token } = JSON.parse(readFileSync(path.join(stand.dir, 'data', 'runtime.json'), 'utf8')) as { token: string }
    const hook = async (body: Record<string, unknown>) => {
      const res = await post('/v1/hook', { cwd, session_id: id, transcript_path: transcript, ...body }, { Authorization: `Bearer ${token}`, 'X-Caprock-Ppid': String(pid) })
      expect(res.status, `hook ${String(body.hook_event_name)}`).toBeLessThan(300)
    }

    await app.open()
    await app.row(name).first().click()
    await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${name}`), selected: true })).toBeVisible()
    await app.waitTerm(id, 'fake-claude ready')
    await page.locator('[data-view-switch]').click()
    const chat = page.locator('[data-chat-view]')
    await expect(chat).toBeVisible()

    // Claude Code opens the transcript with the prompt; the tailer follows it
    // from then on. Its title line is how this test knows the file is read.
    const asked = new Date()
    const line = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: id, version: '2.1.332' }
    appendFileSync(transcript, `${JSON.stringify({ ...line, type: 'user', uuid: 'u-1', parentUuid: null, promptId: 'p-late', timestamp: asked.toISOString(), message: { role: 'user', content: 'can a promo code be made?' } })}\n` +
      `${JSON.stringify({ type: 'ai-title', aiTitle: 'Promo code', sessionId: id })}\n`)
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'can a promo code be made?', prompt_id: 'p-late' })
    await expect.poll(async () => {
      const s = await (await fetch(`${stand.daemonURL}/v1/sessions/${id}`)).json() as { title?: string; session?: { title?: string } }
      return (s.session ?? s).title ?? ''
    }, { timeout: 40_000 }).toBe('Promo code')
    await expect(chat.getByText('can a promo code be made?')).toBeVisible()
    const replied = new Date(Date.now() - 5)
    await hook({ hook_event_name: 'Stop', prompt_id: 'p-late', stop_hook_active: false, last_assistant_message: answer })

    // The reply, written after the Stop with an earlier time, in one write
    // so the tailer reads both lines in one pass.
    const at = replied.toISOString()
    const base = { ...line, type: 'assistant', timestamp: at }
    const message = (content: unknown[]) => ({
      model: 'claude-haiku-5-5', id: 'msg_late_1', type: 'message', role: 'assistant', content, stop_reason: null,
      usage: { input_tokens: 2, output_tokens: 1103, cache_read_input_tokens: 25651, cache_creation_input_tokens: 22105 },
    })
    appendFileSync(transcript,
      `${JSON.stringify({ ...base, uuid: 'a-1', parentUuid: 'u-1', message: message([{ type: 'thinking', thinking: '…' }]) })}\n` +
      `${JSON.stringify({ ...base, uuid: 'a-2', parentUuid: 'a-1', message: message([{ type: 'text', text: answer }]) })}\n`)

    // The daemon holds it, after the Stop by id and before it by time.
    type Ev = { id: number; ts: string; kind: string; payload?: { text?: string } }
    const events = async () => (await (await fetch(`${stand.daemonURL}/v1/sessions/${id}/events?newest=1&limit=300`)).json()) as Ev[]
    await expect.poll(async () => (await events()).find((e) => e.kind === 'turn.assistant')?.payload?.text ?? '', { timeout: 15_000 }).toBe(answer)
    const held = await events()
    const reply = held.find((e) => e.kind === 'turn.assistant')!
    const stop = held.find((e) => e.kind === 'agent.stop')!
    expect(reply.id).toBeGreaterThan(stop.id)
    expect(Date.parse(reply.ts)).toBeLessThan(Date.parse(stop.ts))

    await expect(chat.getByText(answer)).toBeVisible()

    await page.reload()
    await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${name}`), selected: true })).toBeVisible()
    const again = page.locator('[data-chat-view]')
    if (!(await again.isVisible())) await page.locator('[data-view-switch]').click()
    await expect(again.getByText(answer)).toBeVisible()
    await expect(again.getByText('can a promo code be made?')).toBeVisible()
  } finally {
    // This stand started it, so this stand stops it (rule 7); the page is
    // closed first so its tab does not turn into a shell.
    await page.close()
    await stopAgent(stand.daemonURL, id)
  }
})
