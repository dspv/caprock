/**
 * The golden paths: what has to work in every release, driven as a person
 * drives it, against the sandboxed stand (ui/e2e/stand.ts). Each test starts
 * on a fresh page with nothing in its storage; the fixture fails any test
 * that logs a console error, throws, or sends a request off the stand.
 */
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

test('a file dropped by the native shell types its path into the terminal under the point', async ({ app, page }) => {
  await app.open()
  const s = await app.openSession('alpha')
  const box = await page.locator('.xterm').first().boundingBox()
  const side = await app.sidebar.boundingBox()
  if (!box || !side) throw new Error('no terminal or sidebar box')
  // What the app's shell sends on a drop (app/src-tauri/src/main.rs, the
  // webview's DragDrop): paths and the point, as lib/xtermInput reads them.
  const drop = (paths: string[], x: number, y: number) => page.evaluate(({ paths, x, y }) => {
    window.dispatchEvent(new CustomEvent('caprock:drop-paths', { detail: { paths, x, y } }))
  }, { paths, x, y })
  // On the sidebar: not this terminal's drop, so nothing is typed.
  await drop(['/tmp/not-here.txt'], side.x + side.width / 2, side.y + side.height / 2)
  await drop(['/tmp/e2e drop/notes.txt'], box.x + box.width / 2, box.y + box.height / 2)
  await app.waitTerm(s.id, '"/tmp/e2e drop/notes.txt"')
  await page.keyboard.press('Enter')
  await app.waitTerm(s.id, 'you-said:"/tmp/e2e drop/notes.txt"')
  expect(await app.termText(s.id)).not.toContain('not-here')
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
