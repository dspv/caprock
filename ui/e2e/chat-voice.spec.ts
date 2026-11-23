/**
 * Voice input in the desktop app's message fields (ADR-102, .ai/04-ui.md §
 * Voice input on a computer), against the sandboxed stand with the native
 * bridge stubbed: the page runs as if inside the Mac app, and the shell's
 * dictation commands answer from a script that plays back words the way
 * dictate.rs does (`caprock:dictation` events). No microphone, no speech
 * recogniser and no OS dialog are touched.
 *
 * The composer under a terminal: hold the mic, the words appear in the box
 * after what was typed, the release leaves them there unsent; a click starts
 * and the next click stops; a language with no on-device model is refused
 * with its line. The chat view's field gets the same mic.
 *
 * With VOICE_SHOTS set to a folder, the composer's states are saved there.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, stopAgent, test } from './fixtures'

const shots = process.env.VOICE_SHOTS

/**
 * The shell, stubbed: the dictation commands play back words as dictate.rs
 * sends them; every other command answers nothing, as an older shell would,
 * and the page already treats each as optional.
 */
async function stubShell(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Detail = Record<string, unknown>
    const w = window as unknown as { __TAURI_INTERNALS__: unknown; __dict: { calls: [string, unknown][] } }
    w.__dict = { calls: [] }
    let next = 1
    const emit = (detail: Detail, ms: number) => setTimeout(() => window.dispatchEvent(new CustomEvent('caprock:dictation', { detail })), ms)
    const langs = new Map<number, string>()
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        w.__dict.calls.push([cmd, args])
        if (cmd === 'dictation_status') return { supported: true }
        if (cmd === 'dictation_start') {
          const id = next++
          const lang = String(args?.lang ?? '')
          langs.set(id, lang)
          if (lang.startsWith('uk')) emit({ kind: 'end', id, error: 'on-device-unavailable' }, 30)
          else {
            emit({ kind: 'partial', id, text: 'run the' }, 60)
            emit({ kind: 'partial', id, text: 'run the tests' }, 120)
          }
          return id
        }
        if (cmd === 'dictation_stop') {
          const id = Number(args?.id)
          if (!args?.cancel && !langs.get(id)?.startsWith('uk')) {
            emit({ kind: 'final', id, text: 'run the tests.' }, 20)
            emit({ kind: 'end', id }, 30)
          }
          return null
        }
        return null
      },
      transformCallback: () => 0,
    }
    try {
      localStorage.setItem('caprock.app.composer', '1')
      localStorage.setItem('caprock.speech.lang', 'en-US')
    } catch { /* no storage */ }
  })
}

test('the composer mic: hold to talk puts the words in the box, unsent; errors say why', async ({ app, page, stand }) => {
  await stubShell(page)
  const cwd = stand.sessions[0]!.cwd
  const r = await fetch(`${stand.daemonURL}/v1/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) })
  expect(r.ok).toBe(true)
  const { session_id: id } = await r.json() as { session_id: string }
  const name = 'e2e voice input'
  await fetch(`${stand.daemonURL}/v1/sessions/${id}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
  const shot = async (file: string) => {
    if (!shots) return
    mkdirSync(shots, { recursive: true })
    await page.locator('[data-composer]').screenshot({ path: path.join(shots, file) })
  }
  try {
    await app.open()
    await app.row(name).first().click()
    await app.waitTerm(id, 'fake-claude ready')
    const composer = page.locator('[data-composer]')
    const box = composer.getByRole('textbox', { name: /^Message / })
    const mic = composer.getByTestId('desk-mic')
    await expect(mic).toBeVisible()
    await expect(composer.getByTestId('desk-voice-lang')).toHaveText('EN')
    await box.fill('Please')
    await shot('1-idle.png')

    // Hold to talk.
    const b = (await mic.boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.down()
    await expect(box).toHaveValue('Please run the tests')
    await expect(composer.getByRole('status')).toContainText('Listening in English — release to stop')
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await shot('2-listening.png')
    await page.waitForTimeout(400) // past HOLD_MS: a hold, not a click
    await page.mouse.up()
    await expect(box).toHaveValue('Please run the tests.')
    await expect(mic).toHaveAttribute('data-phase', 'inserted')
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    await shot('3-inserted.png')
    // Not sent: the box still holds it and the queue is empty.
    const q = await (await fetch(`${stand.daemonURL}/v1/agents/${id}/queue`)).json() as { messages: unknown[] }
    expect(q.messages).toHaveLength(0)
    expect(await app.termText(id)).not.toContain('run the tests')

    // A click starts, the next click stops.
    await box.fill('')
    await mic.click()
    await expect(box).toHaveValue('run the tests')
    await expect(composer.getByRole('status')).toContainText('click the mic to stop')
    await mic.click()
    await expect(box).toHaveValue('run the tests.')

    // A language with no on-device model here: refused, named, nothing recorded.
    await box.fill('')
    await page.evaluate(() => localStorage.setItem('caprock.speech.lang', 'uk-UA'))
    await mic.click()
    await expect(composer.getByRole('status')).toContainText("Ukrainian isn't available on this Mac without sending audio to Apple")
    await expect(box).toHaveValue('')
    await shot('4-unavailable-language.png')

    const calls = await page.evaluate(() => (window as unknown as { __dict: { calls: [string, Record<string, unknown>][] } }).__dict.calls)
    expect(calls.filter(([c]) => c === 'dictation_start').map(([, a]) => a.lang)).toEqual(['en-US', 'en-US', 'uk-UA'])
  } finally {
    await page.close()
    await stopAgent(stand.daemonURL, id)
  }
})

test('the chat view field has the same mic', async ({ page, stand }) => {
  await stubShell(page)
  const cwd = stand.sessions[0]!.cwd
  const r = await fetch(`${stand.daemonURL}/v1/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) })
  expect(r.ok).toBe(true)
  const { session_id: id } = await r.json() as { session_id: string }
  try {
    await page.goto(`${stand.pageURL}/#/session/${encodeURIComponent(id)}?tab=chat`)
    const chat = page.locator('[data-chat-view]')
    const field = chat.getByRole('textbox', { name: 'Type to the session' })
    const mic = chat.getByTestId('desk-mic')
    await expect(mic).toBeVisible()
    await mic.click()
    await expect(field).toHaveValue('run the tests')
    if (shots) {
      mkdirSync(shots, { recursive: true })
      await field.locator('xpath=../..').screenshot({ path: path.join(shots, '5-chat-listening.png') })
    }
    await mic.click()
    await expect(field).toHaveValue('run the tests.')
    const q = await (await fetch(`${stand.daemonURL}/v1/agents/${id}/queue`)).json() as { messages: unknown[] }
    expect(q.messages).toHaveLength(0)
  } finally {
    await page.close()
    await stopAgent(stand.daemonURL, id)
  }
})
