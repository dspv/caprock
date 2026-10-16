/**
 * The golden paths: what has to work in every release, driven as a person
 * drives it, against the sandboxed stand (ui/e2e/stand.ts). Each test starts
 * on a fresh page with nothing in its storage; the fixture fails any test
 * that logs a console error, throws, or sends a request off the stand.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures'

test('the dashboard and the app workspace load with no console errors', async ({ app, page }) => {
  await page.goto(`${app.stand.pageURL}/#/`)
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Home' })).toBeVisible()
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Cost', exact: true })).toBeVisible()
  // Home lists the running sessions, each a card that links to it.
  for (const s of app.stand.sessions) await expect(page.locator(`a[href="#/session/${s.id}"]`).first()).toBeVisible()
  await app.open()
  await expect(app.sidebar.getByRole('heading', { name: 'Sessions' })).toBeVisible()
  await expect(app.sidebar.getByRole('button', { name: /agents? running/ })).toContainText('2')
})

test('a session appears in the sidebar and its tab opens on its terminal', async ({ app }) => {
  await app.open()
  for (const s of app.stand.sessions) await expect(app.row(s.name).first()).toBeVisible()
  const s = await app.openSession('alpha')
  await expect(app.tabs.getByRole('tab', { selected: true })).toHaveAccessibleName(new RegExp(`^${s.name}`))
})

test('every open tab has a sidebar row, in Tree and in Flat', async ({ app }) => {
  await app.open()
  await app.openSession('alpha')
  await app.openSession('beta')
  const names = await app.tabs.getByRole('tab').evaluateAll((els) =>
    els.filter((e) => !e.hasAttribute('data-dashboard-tab')).map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''))
  const titles = app.stand.sessions.map((s) => s.name)
  for (const t of titles) expect(names.some((n) => n.startsWith(t)), `a tab for ${t} in ${JSON.stringify(names)}`).toBe(true)
  const sw = app.sidebar.getByRole('radiogroup', { name: 'List sessions by' })
  for (const mode of ['Projects', 'Tabs', 'Projects']) {
    await sw.getByRole('radio', { name: mode }).click()
    await expect(sw.getByRole('radio', { name: mode })).toBeChecked()
    for (const t of titles) await expect(app.row(t).first(), `${mode}: a row for ${t}`).toBeVisible()
  }
})

test('typing into the terminal reaches the pty', async ({ app, page }) => {
  await app.open()
  const s = await app.openSession('alpha')
  await page.getByRole('textbox', { name: 'Terminal input' }).first().focus()
  await page.keyboard.type('hello from e2e')
  await page.keyboard.press('Enter')
  await app.waitTerm(s.id, 'you-said:hello from e2e')
})

test('pasted text reaches the pty, line by line', async ({ app, page }) => {
  await app.open()
  const s = await app.openSession('beta')
  const input = page.getByRole('textbox', { name: 'Terminal input' }).first()
  await input.focus()
  await input.evaluate((el) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', 'pasted one\npasted two\n')
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await app.waitTerm(s.id, 'you-said:pasted one')
  await app.waitTerm(s.id, 'you-said:pasted two')
})

test('a file dropped by the native shell types its path into the terminal under the point, or the one used last', async ({ app, page }) => {
  await app.open()
  const s = await app.openSession('alpha')
  const term = page.locator('.xterm').first()
  const box = await term.boundingBox()
  const side = await app.sidebar.boundingBox()
  if (!box || !side) throw new Error('no terminal or sidebar box')
  // What the app's shell sends on a drop (app/src-tauri/src/shell.rs,
  // on_drop): paths and the point, as lib/xtermInput's routeDrop reads them.
  const drop = (paths: string[], x: number, y: number) => page.evaluate(({ paths, x, y }) => {
    window.dispatchEvent(new CustomEvent('caprock:drop-paths', { detail: { paths, x, y } }))
  }, { paths, x, y })
  // Beside any terminal (here the sidebar): the terminal used last takes it.
  await term.click()
  await drop(['/tmp/e2e side/beside.txt'], side.x + side.width / 2, side.y + side.height / 2)
  await app.waitTerm(s.id, '"/tmp/e2e side/beside.txt"')
  await page.keyboard.press('Enter')
  await app.waitTerm(s.id, 'you-said:"/tmp/e2e side/beside.txt"')
  // On a terminal: that terminal.
  await drop(['/tmp/e2e drop/notes.txt'], box.x + box.width / 2, box.y + box.height / 2)
  await app.waitTerm(s.id, '"/tmp/e2e drop/notes.txt"')
  await page.keyboard.press('Enter')
  await app.waitTerm(s.id, 'you-said:"/tmp/e2e drop/notes.txt"')
})

test('the command palette opens and runs a command', async ({ app, page }) => {
  await app.open()
  await app.chord('k')
  const search = page.getByRole('combobox').or(page.getByPlaceholder(/search|type a command/i)).first()
  await expect(search).toBeFocused()
  await page.keyboard.type('Open the dashboard')
  await expect(page.getByRole('option', { name: /Open the dashboard/ }).first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(app.tabs.getByRole('tab', { name: 'Dashboard', selected: true })).toBeVisible()
  await expect(page.getByRole('option')).toHaveCount(0)
})

test('Settings opens and closes', async ({ app, page }) => {
  await app.open()
  await app.sidebar.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(app.tabs.getByRole('tab', { name: 'Settings', selected: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  await app.tabs.getByRole('button', { name: 'Close tab Settings' }).click()
  await expect(app.tabs.getByRole('tab', { name: 'Settings' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toHaveCount(0)
})

test('the Second Brain screen renders', async ({ app, page }) => {
  await app.open()
  await app.sidebar.getByRole('link', { name: /Open Second Brain/ }).click()
  await expect(page.getByRole('heading', { name: 'Second Brain', level: 1 })).toBeVisible()
  await expect(page.locator('[data-brain-screen]')).not.toHaveAttribute('data-brain-phase', 'loading')
})

test('the Pipeline screen renders', async ({ app, page }) => {
  await app.open()
  await app.sidebar.getByRole('button', { name: /^Pipeline/ }).click()
  await expect(app.tabs.getByRole('tab', { name: 'Pipeline', selected: true })).toBeVisible()
  // The stand's repositories have no GitHub remote: the empty state says why.
  await expect(page.getByText('No repository yet')).toBeVisible()
})

test('the share dialog opens, draws its card and closes, with no network', async ({ app, page }) => {
  await app.open()
  await app.chord('k')
  await page.keyboard.type('Share my numbers')
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Share your figures' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('img', { name: /Your figures/ })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)
})

// Chats (ADR-071): one tap starts a chat in the daemon's chats workspace; it
// opens as a conversation, not a terminal; the files it wrote are listed and
// open in a viewer (HTML in a frame that runs nothing); it is counted on the
// list, archived out of it, and deleted for good with its folder.
test('a chat starts in one tap, opens as a conversation, shows its files, and is archived and deleted', async ({ app, page }) => {
  await page.goto(`${app.stand.pageURL}/#/chats`)
  await page.getByRole('button', { name: /New chat/ }).click()
  await expect(page).toHaveURL(/#\/chats\/[^/?]+$/)
  const id = decodeURIComponent(new URL(page.url()).hash.split('/').pop() ?? '')
  await expect(page.locator('[data-chat-view]')).toBeVisible()
  await expect(page.locator('.xterm')).toHaveCount(0)
  const s = await (await fetch(`${app.stand.daemonURL}/v1/sessions/${encodeURIComponent(id)}`)).json() as { chat?: boolean; cwd: string; owned: boolean }
  expect(s.chat).toBe(true)
  expect(s.owned).toBe(true)
  expect(s.cwd.startsWith(path.join(app.stand.dir, 'data', 'chats'))).toBe(true)

  // What an agent would write in its folder.
  writeFileSync(path.join(s.cwd, 'report.md'), '# Findings\n\nAll good.\n')
  writeFileSync(path.join(s.cwd, 'page.html'), '<h1>A page</h1>')
  await page.reload()
  await page.getByRole('button', { name: 'Files · 2' }).click()
  await page.getByRole('dialog', { name: 'Files · 2' }).getByText('report.md').click()
  const md = page.getByRole('dialog', { name: 'report.md' })
  await expect(md.getByRole('heading', { name: 'Findings' })).toBeVisible()
  await md.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'Files · 2' }).click()
  await page.getByRole('dialog', { name: 'Files · 2' }).getByText('page.html').click()
  const html = page.getByRole('dialog', { name: 'page.html' })
  // A frame that runs no script and fetches nothing. Its contents are not
  // read from here: a test's own probe is a script, and the sandbox blocks
  // it (as it should), which the console reports as an error.
  await expect(html.locator('iframe')).toHaveAttribute('sandbox', '')
  await expect(html.locator('iframe')).toHaveAttribute('srcdoc', /default-src 'none'.*<h1>A page<\/h1>/)
  await html.getByRole('button', { name: 'Close' }).click()

  // The list counts it; Archive hides it; Delete removes it and its files.
  await page.goto(`${app.stand.pageURL}/#/chats`)
  const list = page.getByRole('list', { name: 'Chats' })
  await expect(list.getByRole('link')).toHaveCount(1)
  await expect(page.getByLabel('1 chats')).toBeVisible()
  await list.getByRole('button', { name: /^More for / }).click()
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(page.getByText('No chats yet.')).toBeVisible()
  await page.getByRole('link', { name: 'Archived · 1' }).click()
  await page.getByRole('list', { name: 'Chats' }).getByRole('button', { name: /^More for / }).click()
  await page.getByRole('menuitem', { name: 'Delete…' }).click()
  await page.getByRole('menuitem', { name: /Delete for good/ }).click()
  await expect(page.getByText('No archived chats.')).toBeVisible()
  await expect.poll(async () => (await fetch(`${app.stand.daemonURL}/v1/sessions/${encodeURIComponent(id)}`)).status).toBe(404)
})
