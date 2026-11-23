/**
 * Voice input on Windows and Linux (ADR-104, .ai/04-ui.md § Voice input on a
 * computer), against the sandboxed stand with the native side stubbed: the
 * page runs as if inside the Windows app, whose shell answers the dictation
 * and voice-model commands from a script. No microphone, no model, no
 * download and no OS dialog are touched.
 *
 * The path a new user takes: the chat's mic without a voice model says to
 * download one and links to Settings → Voice input; the download there shows
 * its progress and ends installed; back in the chat the mic listens, says
 * it is recognised on this computer, and puts the words in the field unsent.
 *
 * With VOICE_SHOTS set to a folder, the block's and the field's states are
 * saved there.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, stopAgent, test } from './fixtures'

const shots = process.env.VOICE_SHOTS

async function shot(el: Locator, file: string): Promise<void> {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await el.screenshot({ path: path.join(shots, file) })
}

/** The Windows shell, stubbed: the model downloads in three status polls. */
async function stubWindowsShell(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' })
    type Model = 'small' | 'base'
    const w = window as unknown as {
      __TAURI_INTERNALS__: unknown
      __voice: { calls: [string, unknown][]; installed: Model | null; downloading: Model | null; polls: number }
    }
    w.__voice = { calls: [], installed: null, downloading: null, polls: 0 }
    const v = w.__voice
    const models = [
      { id: 'small', file: 'ggml-small-q5_1.bin', bytes: 190_970_585 },
      { id: 'base', file: 'ggml-base.bin', bytes: 148_836_563 },
    ]
    const dir = 'C:\\Users\\me\\AppData\\Local\\dev.caprock.app\\voice'
    let next = 1
    const emit = (detail: Record<string, unknown>, ms: number) => setTimeout(() => window.dispatchEvent(new CustomEvent('caprock:dictation', { detail })), ms)
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        v.calls.push([cmd, args])
        if (cmd === 'dictation_status') {
          if (v.downloading) return { supported: false, reason: 'downloading', engine: 'whisper' }
          if (!v.installed) return { supported: false, reason: 'no-model', engine: 'whisper' }
          return { supported: true, engine: 'whisper' }
        }
        if (cmd === 'voice_model_status') {
          const st: Record<string, unknown> = { offered: true, cpu_ok: true, dir, models }
          if (v.downloading) {
            v.polls++
            const total = models.find((m) => m.id === v.downloading)!.bytes
            if (v.polls >= 3) {
              v.installed = v.downloading
              v.downloading = null
            } else {
              st.download = { model: v.downloading, done: Math.round((total * v.polls) / 3), total }
            }
          }
          if (v.installed) {
            st.installed = v.installed
            st.path = `${dir}\\${models.find((m) => m.id === v.installed)!.file}`
          }
          return st
        }
        if (cmd === 'voice_model_download') {
          v.downloading = String(args?.model) as Model
          v.polls = 0
          return null
        }
        if (cmd === 'dictation_start') {
          const id = next++
          emit({ kind: 'listening', id }, 20)
          emit({ kind: 'partial', id, text: 'Run the tests.' }, 80)
          return id
        }
        if (cmd === 'dictation_stop') {
          const id = Number(args?.id)
          if (!args?.cancel) {
            // whisper finishes the last piece after the release.
            emit({ kind: 'final', id, text: 'Run the tests. Then push.' }, 400)
            emit({ kind: 'end', id }, 420)
          }
          return null
        }
        return null
      },
      transformCallback: () => 0,
    }
    try {
      localStorage.setItem('caprock.speech.lang', 'en-US')
    } catch { /* no storage */ }
  })
}

test('Windows: the mic offers the voice model, Settings downloads it, then the mic listens', async ({ page, stand }) => {
  await stubWindowsShell(page)
  const cwd = stand.sessions[0]!.cwd
  const r = await fetch(`${stand.daemonURL}/v1/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) })
  expect(r.ok).toBe(true)
  const { session_id: id } = await r.json() as { session_id: string }
  const sessionURL = `${stand.pageURL}/#/session/${encodeURIComponent(id)}?tab=chat`
  try {
    await page.goto(sessionURL)
    const chat = page.locator('[data-chat-view]')
    const field = chat.getByRole('textbox', { name: 'Type to the session' })
    const mic = chat.getByTestId('desk-mic')
    await expect(mic).toBeVisible()

    // No model yet: the press says where to get it, and records nothing.
    await field.fill('Please')
    await mic.click()
    await expect(chat.getByRole('status')).toContainText('Voice input needs a voice model. Download it in Settings → Voice input')
    await expect(field).toHaveValue('Please')
    await shot(field.locator('xpath=../..'), 'w1-chat-no-model.png')
    await chat.getByTestId('desk-voice-settings').click()
    await expect(page).toHaveURL(/#\/settings\/voice$/)

    // Settings → Voice input: what goes and where, then the download.
    const section = page.locator('#settings-voice-input')
    await expect(section).toBeVisible()
    await expect(section.getByRole('radio', { name: /Accurate · small, 191 MB/ })).toHaveAttribute('aria-checked', 'true')
    await expect(section.locator('[data-voice-download-note]')).toContainText('huggingface.co')
    await expect(section.locator('[data-voice-download-note]')).toContainText('your voice never leaves this computer')
    await shot(section, 'w2-settings-none.png')
    await section.getByRole('button', { name: /^Download voice model · 191 MB$/ }).click()
    await expect(section.getByRole('progressbar', { name: 'Voice model download' })).toBeVisible()
    await shot(section, 'w3-settings-downloading.png')
    await expect(section.getByText(/Installed · small · 191 MB · checksum verified/)).toBeVisible()
    await expect(section.getByText('C:\\Users\\me\\AppData\\Local\\dev.caprock.app\\voice\\ggml-small-q5_1.bin')).toBeVisible()
    await shot(section, 'w4-settings-installed.png')

    // Back in the chat (the same page: the hash, no reload): the mic listens
    // on this computer, the words land unsent.
    await page.evaluate((h) => { location.hash = h }, `#/session/${encodeURIComponent(id)}?tab=chat`)
    await expect(mic).toBeVisible()
    await field.fill('')
    await mic.click()
    await expect(chat.getByRole('status')).toContainText('Recognised on this computer; nothing is sent.')
    await expect(field).toHaveValue('Run the tests.')
    await shot(field.locator('xpath=../..'), 'w5-chat-listening.png')
    await mic.click()
    await expect(chat.getByRole('status')).toContainText('Finishing…')
    await expect(field).toHaveValue('Run the tests. Then push.')
    const q = await (await fetch(`${stand.daemonURL}/v1/agents/${id}/queue`)).json() as { messages: unknown[] }
    expect(q.messages).toHaveLength(0)

    const calls = await page.evaluate(() => (window as unknown as { __voice: { calls: [string, Record<string, unknown>][] } }).__voice.calls)
    expect(calls.filter(([c]) => c === 'dictation_start').map(([, a]) => a.lang)).toEqual(['en-US'])
  } finally {
    await page.close()
    await stopAgent(stand.daemonURL, id)
  }
})
