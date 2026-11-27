/**
 * A dropped PDF in a prompt is a chip, not its path (owner, 2026-11-27,
 * translated: "can PDFs also be optimized the way images are displayed?";
 * .ai/04-ui.md § File chips), against the sandboxed stand. The prompt is
 * written into the stand's own transcript as Claude Code records a dropped
 * file: its quoted path under the paste folder, then the words. The chat's
 * bubble shows the file's name with a PDF icon and the words; a click shows
 * the whole path. With the session's name cleared, its sidebar row is named
 * by the file, not by `Application Support/caprock/paste/…`.
 */
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, stopAgent, test } from './fixtures'

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''

test('a dropped PDF reads as a chip in the chat and as its name in the sidebar', async ({ app, page, stand }) => {
  const cwd = stand.sessions[0]!.cwd
  const r = await fetch(`${stand.daemonURL}/v1/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) })
  expect(r.ok).toBe(true)
  const { session_id: id } = await r.json() as { session_id: string }
  const setName = (name: string) => fetch(`${stand.daemonURL}/v1/sessions/${id}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
  const name = 'e2e file chip'
  await setName(name)
  const dir = path.join(stand.dir, 'home', '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  const transcript = path.join(dir, `${id}.jsonl`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(transcript, '')
  const pdf = path.join(stand.dir, 'Library', 'Application Support', 'caprock', 'paste', 'drop-1795599021771608000', 'Some_File_Name.pdf')
  const prompt = `"${pdf}" how is my CV?`
  try {
    await app.open()
    await app.row(name).first().click()
    await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${name}`), selected: true })).toBeVisible()
    await app.waitTerm(id, 'fake-claude ready')
    await page.locator('[data-view-switch]').click()
    const chat = page.locator('[data-chat-view]')
    await expect(chat).toBeVisible()

    const line = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: id, version: '2.1.332' }
    appendFileSync(transcript, `${JSON.stringify({ ...line, type: 'user', uuid: 'u-1', parentUuid: null, timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } })}\n`)

    const chip = chat.locator('[data-path-chip="pdf"]')
    await expect(chip).toBeVisible({ timeout: 20_000 })
    await expect(chip).toContainText('Some_File_Name.pdf')
    await expect(chip.locator('[data-file-icon="pdf"]')).toBeVisible()
    await expect(chat.getByText('how is my CV?')).toBeVisible()
    await expect(chat.getByText('Application Support', { exact: false })).toHaveCount(0)
    if (shotsDir) await chat.locator('[data-msg-id]').first().screenshot({ path: path.join(shotsDir, 'file-chip-bubble.png') })

    await chip.getByRole('button').click()
    await expect(chip.locator('[data-file-path]')).toHaveText(pdf)
    if (shotsDir) await chat.locator('[data-msg-id]').first().screenshot({ path: path.join(shotsDir, 'file-chip-open.png') })

    // A PDF attached in the chat's field is a chip with the PDF icon and
    // its name before it is sent; taken out again, nothing is sent.
    const chooser = page.waitForEvent('filechooser')
    await chat.getByRole('button', { name: 'Attach a photo or file' }).last().click()
    await (await chooser).setFiles({ name: 'My CV 2026.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') })
    const attached = page.locator('[data-attached] li', { hasText: 'My CV 2026.pdf' })
    await expect(attached).toBeVisible()
    await expect(attached.locator('[data-file-icon="pdf"]')).toBeVisible()
    if (shotsDir) await page.locator('[data-attached]').screenshot({ path: path.join(shotsDir, 'file-chip-composer.png') })
    await attached.getByRole('button', { name: /^Remove/ }).click()
    await expect(attached).toHaveCount(0)

    // Its name cleared, the row is named by the prompt, the path cut to the file.
    await setName('')
    await expect(app.sidebar.getByText(/Some_File_Name\.pdf how is my CV/).first()).toBeVisible({ timeout: 15_000 })
    await expect(app.sidebar.getByText(/Application Support/)).toHaveCount(0)
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'file-chip-app.png') })
  } finally {
    await page.close()
    await stopAgent(stand.daemonURL, id)
  }
})
