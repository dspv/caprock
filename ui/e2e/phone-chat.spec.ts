/**
 * The phone's chat, as a phone uses it (.ai/04-ui.md § From a phone,
 * *Replies as Markdown*, *Hold a reply*, *The keyboard goes away*): a reply
 * drawn as Markdown, the hold's menu, and every way the keyboard goes away.
 * A phone profile (isMobile, hasTouch), so the page sees a finger.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { devices, type Page } from '@playwright/test'
import { expect, stopAgent, test } from './fixtures'
import type { StandState } from './stand'

const REPLY = [
  '## Summary',
  '',
  '1. **Retry** with backoff',
  '2. *Timeouts* and ~~sleep~~',
  '',
  '```go',
  'func (s *Sender) Deliver(ctx context.Context, ev Event) error { return s.post(ctx, ev) } // a line wider than the phone',
  '```',
  '',
  '| Test | Before | After | Notes |',
  '| --- | --- | --- | --- |',
  '| TestDeliverRetries | FAIL | PASS | flaky on CI before this change |',
  '',
  'Run it with:',
  '',
  '    go test ./internal/webhook/... -run TestDeliver -count=1',
].join('\n')

function transcript(sessionId: string, cwd: string): string {
  let n = 0
  const t0 = Date.now() - 60_000
  const base = (type: string, extra: Record<string, unknown>) => {
    n++
    return JSON.stringify({
      isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId, version: '2.1.296', gitBranch: 'master',
      parentUuid: n > 1 ? `u-${n - 1}` : null, type, uuid: `u-${n}`, timestamp: new Date(t0 + n * 1000).toISOString(), ...extra,
    })
  }
  const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: 'standard' }
  return [
    base('user', { promptId: 'p-1', message: { role: 'user', content: [{ type: 'text', text: 'Summarise the webhook change' }] } }),
    base('assistant', { requestId: 'req-1', message: { model: 'claude-sonnet-4-6', id: 'msg-1', type: 'message', role: 'assistant', content: [{ type: 'text', text: REPLY }], usage } }),
  ].join('\n') + '\n'
}

async function seed(stand: StandState, id: string, cwd: string): Promise<void> {
  const dir = path.join(stand.dir, 'home', '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  await new Promise((r) => setTimeout(r, 1000))
  writeFileSync(path.join(dir, `${id}.jsonl`), transcript(id, cwd))
}

/** Touches as a finger makes them; `touches` set on the event, which every engine reads. */
function touch(page: Page, sel: string, type: 'touchstart' | 'touchmove' | 'touchend', dy = 0) {
  return page.evaluate(({ sel, type, dy }) => {
    const el = document.querySelector(sel)!
    const r = el.getBoundingClientRect()
    const ev = new TouchEvent(type, { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [{ clientX: r.left + 40, clientY: r.top + 30 + dy }] })
    el.dispatchEvent(ev)
  }, { sel, type, dy })
}

const focused = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')

test('the phone chat: Markdown replies, the hold menu, and the keyboard that goes away', async ({ browser, stand }) => {
  test.setTimeout(90_000)
  const r = await fetch(`${stand.daemonURL}/v1/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat: true }) })
  const chat = await r.json() as { session_id: string }
  expect(r.ok, JSON.stringify(chat)).toBe(true)
  const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } })
  try {
    const { cwd } = await (await fetch(`${stand.daemonURL}/v1/sessions/${chat.session_id}`)).json() as { cwd: string }
    await seed(stand, chat.session_id, cwd)
    const page = await ctx.newPage()
    await page.addInitScript(() => { localStorage.setItem('caprock.phone.installHint', '1') })
    await page.goto(`${stand.pageURL}/#/chats/${chat.session_id}`)
    const reply = page.locator('[data-phone-reply]').first()
    await expect(reply).toBeVisible({ timeout: 20_000 })

    // Markdown: a heading, the list, both code blocks with Copy, the table's header.
    await expect(reply.locator('h2')).toHaveText('Summary')
    await expect(reply.locator('pre')).toHaveCount(2)
    await expect(reply.locator('pre').nth(1)).toHaveText('go test ./internal/webhook/... -run TestDeliver -count=1')
    await expect(reply.getByRole('button', { name: 'Copy the code' })).toHaveCount(2)
    await expect(reply.locator('th').first()).toHaveText('Test')
    await expect(reply.locator('em')).toHaveText('Timeouts')
    await expect(reply.locator('s')).toHaveText('sleep')
    // Wider than the phone: it says it scrolls, and the page does not.
    await expect(reply.locator('[data-doc-table]')).toHaveAttribute('data-scroll-more', 'right')
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390)
    await expect(page.getByRole('log').locator('[data-brain-drop]')).toHaveCount(0)

    // Hold: Copy text, Copy code 1 and 2, Drop into 2nd Brain.
    await touch(page, '[data-phone-reply]', 'touchstart')
    await page.waitForTimeout(700)
    await touch(page, '[data-phone-reply]', 'touchend')
    const menu = page.getByRole('menu', { name: 'Reply' })
    await expect(menu.getByRole('menuitem')).toHaveText(['Copy text', /^Copy code 1/, /^Copy code 2/, 'Drop into 2nd Brain'])
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    // Return is a new line on a phone; Send sends and the keyboard goes down.
    const field = page.getByRole('textbox', { name: 'Type to the session' })
    await expect(field).toHaveAttribute('enterkeyhint', 'enter')
    await field.click()
    await field.fill('first line')
    await page.keyboard.press('Enter')
    await expect(field).toHaveValue('first line\n')
    await field.fill('')

    // The button beside the field puts the keyboard away.
    await field.click()
    expect(await focused(page)).toBe('Type to the session')
    await page.locator('[data-hide-keyboard]').click()
    expect(await focused(page)).not.toBe('Type to the session')
    await expect(page.locator('[data-hide-keyboard]')).toHaveCount(0)

    // So does dragging the conversation; a tap-sized move does not.
    await field.click()
    await touch(page, '[role=log]', 'touchstart')
    await touch(page, '[role=log]', 'touchmove', 3)
    expect(await focused(page)).toBe('Type to the session')
    await touch(page, '[role=log]', 'touchmove', 40)
    expect(await focused(page)).not.toBe('Type to the session')

    await field.click()
    await field.fill('from the phone e2e')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByRole('log').getByText('from the phone e2e')).toBeVisible()
    expect(await focused(page)).not.toBe('Type to the session')
  } finally {
    await ctx.close()
    await stopAgent(stand.daemonURL, chat.session_id)
  }
})
