/**
 * The phone never scrolls sideways and never cuts anything off
 * (.ai/04-ui.md § From a phone, *Nothing wider than the screen*).
 *
 * A real phone profile (isMobile, hasTouch: the layout viewport widens to
 * fit the widest element, as Android Chrome does) at 360, 390 and 430 px, on
 * every phone screen, with content made to be wide: a long URL, a code block
 * with a long line, a wide table, long file paths and long tool lines.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { devices, type Browser, type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import type { StandState } from './stand'

const WIDTHS = [360, 390, 430]

const LONG_URL = 'https://github.com/someone/caprock-web/blob/master/docs/' + 'very-long-segment-'.repeat(14) + 'end.md?query=' + 'x'.repeat(80)
const LONG_PATH = '/Users/someone/dev/caprock/.claude/worktrees/' + 'agent-a5b6364f0beb1673c'.repeat(4) + '/ui/src/components/PhoneHome.tsx'
const LONG_WORD = 'Supercalifragilistic'.repeat(12)
const CODE_LINE = 'const result = await fetchEverything({ ' + Array.from({ length: 18 }, (_, i) => `option${i}: "value-${i}"`).join(', ') + ' })'
const TABLE = '| ' + Array.from({ length: 9 }, (_, i) => `Column header ${i}`).join(' | ') + ' |\n|' + ' --- |'.repeat(9) + '\n' +
  Array.from({ length: 3 }, (_, r) => '| ' + Array.from({ length: 9 }, (_, i) => `cell-${r}-${i}-${'wide'.repeat(3)}`).join(' | ') + ' |').join('\n')
const REPLY = [
  `Here is the link: ${LONG_URL}`,
  '',
  `The file is \`${LONG_PATH}\` and the word is ${LONG_WORD}.`,
  '',
  '```ts',
  CODE_LINE,
  CODE_LINE,
  '```',
  '',
  TABLE,
  '',
  `- a list item with ${LONG_URL}`,
  `> a quote with ${LONG_WORD}`,
].join('\n')
const BASH = 'cd ' + LONG_PATH + ' && rg --hidden --glob "!node_modules" "' + 'pattern|'.repeat(30) + '" | head -400'

/** A Claude Code transcript with every kind of wide line, for one session. */
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
  const asst = (id: string, content: unknown[]) => base('assistant', {
    requestId: `req-${id}`, message: { model: 'claude-sonnet-4-6', id: `msg-${id}`, type: 'message', role: 'assistant', content, usage },
  })
  return [
    base('user', { promptId: 'p-1', message: { role: 'user', content: [{ type: 'text', text: `Please read ${LONG_URL} and ${LONG_PATH}, then ${LONG_WORD}` }] } }),
    asst('1', [{ type: 'text', text: REPLY }]),
    asst('2', [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: BASH, description: 'Search ' + LONG_PATH } }]),
    base('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: (LONG_PATH + ':12: ' + CODE_LINE + '\n').repeat(4) }] } }),
    asst('3', [{ type: 'tool_use', id: 'tu-2', name: 'Read', input: { file_path: LONG_PATH } }]),
    base('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: CODE_LINE }] } }),
    asst('4', [{ type: 'tool_use', id: 'tu-3', name: 'Edit', input: { file_path: LONG_PATH, old_string: CODE_LINE, new_string: CODE_LINE + ' // changed' } }]),
    base('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-3', content: 'The file ' + LONG_PATH + ' has been updated.' }] } }),
    asst('5', [{ type: 'tool_use', id: 'tu-4', name: 'mcp__' + 'playbookserver'.repeat(4) + '__computer', input: { action: LONG_WORD } }]),
    base('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-4', content: 'ok' }] } }),
    asst('6', [{ type: 'text', text: REPLY }]),
  ].join('\n') + '\n'
}

async function seed(stand: StandState, id: string, cwd: string): Promise<void> {
  const dir = path.join(stand.dir, 'home', '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  // The tailer watches a new directory once it sees it made; a file written
  // after that is read at once, one written with it only on the next rescan.
  await new Promise((r) => setTimeout(r, 1000))
  writeFileSync(path.join(dir, `${id}.jsonl`), transcript(id, cwd))
}

interface Measure { w: number; inner: number; client: number; scroll: number; cut: string[]; sideways: string[]; zoom: string[] }

/**
 * What sticks out past the screen's right edge: the page's scroll width,
 * the layout viewport (which a mobile browser widens to fit), and every
 * element whose right edge passes `w` and is not inside a box that clips or
 * scrolls it within the screen (a code block scrolls in its own frame).
 */
async function measure(page: Page, w: number): Promise<Measure> {
  return page.evaluate((w) => {
    const clippedWithin = (el: Element): boolean => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p)
        if (cs.overflowX !== 'visible' && p.getBoundingClientRect().right <= w + 0.5) return true
      }
      return false
    }
    const cut = [...document.querySelectorAll('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0 || r.right <= w + 0.5) return false
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden') return false
        return !clippedWithin(el)
      })
      .slice(0, 12)
      .map((el) => {
        const cls = typeof el.className === 'string' ? el.className.slice(0, 70) : ''
        const label = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 40)
        return `${el.tagName.toLowerCase()}.${cls} "${label}" right=${Math.round(el.getBoundingClientRect().right)}`
      })
    // A box that scrolls sideways is a sideways scroll on a phone too, unless
    // it is a code block, a table or a terminal, which scroll in their frame.
    const own = (el: Element) => el.matches('pre, pre *, table, [data-scroll-x], .xterm, .xterm *') || !!el.querySelector(':scope > pre, :scope > table')
    const sideways = [...document.querySelectorAll('body, body *')]
      .filter((el) => {
        const cs = getComputedStyle(el)
        return (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && !own(el)
      })
      .slice(0, 12)
      .map((el) => {
        const cls = typeof el.className === 'string' ? el.className.slice(0, 70) : ''
        return `${el.tagName.toLowerCase()}.${cls} [${el.getAttribute('aria-label') ?? el.getAttribute('role') ?? ''}] scrollWidth=${el.scrollWidth} clientWidth=${el.clientWidth}`
      })
    // iOS zooms the page in on a field whose text is under 16px, and the
    // zoomed page then pans sideways until pinched back.
    const zoom = [...document.querySelectorAll('input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select, [contenteditable=true]')]
      .filter((el) => el.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? ''}] ${getComputedStyle(el).fontSize}`)
    return {
      sideways, zoom,
      w, inner: window.innerWidth, client: document.documentElement.clientWidth,
      scroll: document.scrollingElement!.scrollWidth, cut,
    }
  }, w)
}

async function phone(browser: Browser, width: number): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width, height: 800 },
    screen: { width, height: 800 },
  })
  const page = await ctx.newPage()
  return { page, close: () => ctx.close() }
}

test('the phone never scrolls sideways or cuts anything off, at 360, 390 and 430 px', async ({ app, browser, stand }) => {
  test.setTimeout(540_000)
  const s = app.session('alpha')
  // A chat, as the phone starts one, with the same wide transcript.
  const r = await fetch(`${stand.daemonURL}/v1/agents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat: true }),
  })
  const chat = await r.json() as { session_id: string; cwd?: string }
  expect(r.ok, JSON.stringify(chat)).toBe(true)
  const cdetail = await (await fetch(`${stand.daemonURL}/v1/sessions/${chat.session_id}`)).json() as { cwd: string }
  await seed(stand, s.id, s.cwd)
  await seed(stand, chat.session_id, cdetail.cwd)
  await expect.poll(async () => {
    const ev = await (await fetch(`${stand.daemonURL}/v1/sessions/${s.id}/events?newest=1&limit=50`)).json() as unknown
    return Array.isArray(ev) ? ev.length : 0
  }, { timeout: 20_000, message: 'the transcript was ingested' }).toBeGreaterThan(5)
  // Long names, files the chat wrote with long names and wide contents, and
  // an Inbox note that is one long link, as a phone's Share leaves one.
  const put = (p: string, body: unknown, method = 'POST') => fetch(`${stand.daemonURL}${p}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  expect((await put(`/v1/sessions/${s.id}/name`, { name: `e2e alpha ${LONG_WORD}` }, 'PUT')).ok).toBe(true)
  const fname = `report-${'quarterly-numbers-'.repeat(6)}final.md`
  writeFileSync(path.join(cdetail.cwd, fname), `# Report\n\n${REPLY}\n`)
  writeFileSync(path.join(cdetail.cwd, 'wide.csv'), Array.from({ length: 4 }, (_, r) => Array.from({ length: 14 }, (_, i) => `value-${r}-${i}-${LONG_WORD.slice(0, 20)}`).join(',')).join('\n'))
  expect((await put('/v1/inbox', { text: `Read later: ${LONG_URL}` })).ok).toBe(true)
  const tap = (name: string | RegExp, role: 'button' | 'link' | 'tab' | 'menuitem' = 'button') => async (p: Page) => {
    await p.getByRole(role, { name }).first().click()
    await p.waitForTimeout(400)
  }
  const typeLong = async (p: Page) => {
    const f = p.getByRole('textbox', { name: 'Type to the session' }).first()
    await f.click()
    await f.fill(`Please look at ${LONG_URL} and ${LONG_PATH} ${LONG_WORD}`)
  }

  const screens: { name: string; hash: string; ready?: (p: Page) => Promise<void> }[] = [
    // The install hint shows once, over the top of Home.
    { name: 'home', hash: '#/', ready: async (p) => { await p.evaluate(() => localStorage.setItem('caprock.phone.installHint', '1')) } },
    { name: 'home, no hint', hash: '#/' },
    { name: 'home, chats open', hash: '#/', ready: async (p) => { await p.getByRole('button', { name: /^Chats/ }).click() } },
    { name: 'home, more menu', hash: '#/', ready: tap('More') },
    { name: 'home, row menu', hash: '#/', ready: async (p) => { await p.getByRole('region', { name: 'Continue' }).getByRole('button', { name: /more|⋯|actions/i }).first().click(); await p.waitForTimeout(400) } },
    { name: 'full dashboard', hash: '#/home' },
    { name: 'chats', hash: '#/chats' },
    { name: 'chat', hash: `#/chats/${chat.session_id}` },
    { name: 'chat, more sheet', hash: `#/chats/${chat.session_id}`, ready: tap('More') },
    { name: 'chat, files sheet', hash: `#/chats/${chat.session_id}`, ready: tap(/^Files/) },
    { name: 'chat, markdown file', hash: `#/chats/${chat.session_id}`, ready: async (p) => { await tap(/^Files/)(p); await tap(/report-quarterly/)(p) } },
    { name: 'chat, csv file', hash: `#/chats/${chat.session_id}`, ready: async (p) => { await tap(/^Files/)(p); await tap(/wide\.csv/)(p) } },
    { name: 'chat, keys open', hash: `#/chats/${chat.session_id}`, ready: tap(/^Keys$/) },
    { name: 'chat, typing a long line', hash: `#/chats/${chat.session_id}`, ready: typeLong },
    { name: 'chat, long message queued', hash: `#/chats/${chat.session_id}`, ready: async (p) => { await typeLong(p); await p.keyboard.press('Enter'); await p.waitForTimeout(800) } },
    { name: 'session chat', hash: `#/session/${s.id}?tab=chat` },
    { name: 'session, other views', hash: `#/session/${s.id}?tab=chat`, ready: tap(/other views|Other views/, 'tab') },
    { name: 'session, details', hash: `#/session/${s.id}?tab=chat`, ready: tap(/session details/) },
    { name: 'session, end sheet', hash: `#/session/${s.id}?tab=chat`, ready: tap(/^End /) },
    { name: 'session, typing', hash: `#/session/${s.id}?tab=chat`, ready: typeLong },
    { name: 'session terminal', hash: `#/session/${s.id}?tab=terminal` },
    { name: 'session timeline', hash: `#/session/${s.id}?tab=timeline` },
    { name: 'settings', hash: '#/settings' },
    { name: 'settings phone', hash: '#/settings/phone' },
    { name: 'cost', hash: '#/cost' },
    { name: 'history', hash: '#/history' },
  ]
  const problems: string[] = []
  for (const width of WIDTHS) {
    const { page, close } = await phone(browser, width)
    page.setDefaultTimeout(5000)
    try {
      for (const sc of screens) {
        await page.goto('about:blank')
        await page.goto(`${stand.pageURL}/${sc.hash}`)
        await page.waitForLoadState('networkidle').catch(() => {})
        await page.waitForTimeout(600)
        if (sc.ready) {
          try { await sc.ready(page) } catch (e) { problems.push(`${width} ${sc.name}: could not get ready: ${String(e).split('\n')[0]}`); continue }
        }
        await page.waitForTimeout(300)
        const m = await measure(page, width)
        await page.screenshot({ path: test.info().outputPath(`${sc.name.replace(/\W+/g, '-')}-${width}.png`) })
        const bad = m.scroll > width || m.inner > width || m.client > width || m.cut.length > 0 || m.sideways.length > 0 || m.zoom.length > 0
        console.log(`${width} ${sc.name}: inner=${m.inner} client=${m.client} scroll=${m.scroll}${m.cut.length ? '\n  cut ' + m.cut.join('\n  cut ') : ''}${m.sideways.length ? '\n  scrolls ' + m.sideways.join('\n  scrolls ') : ''}${m.zoom.length ? '\n  zoom ' + m.zoom.join('\n  zoom ') : ''}`)
        if (bad) problems.push(`${width} ${sc.name}: scroll=${m.scroll} inner=${m.inner} ${[...m.cut, ...m.sideways, ...m.zoom].join(' | ')}`)
      }
    } finally {
      await close()
    }
  }
  expect(problems).toEqual([])
})

test('a link in a chat reply can be tapped on a phone, and a long one wraps, at 360, 390 and 412 px', async ({ browser, stand }) => {
  test.setTimeout(180_000)
  const r = await fetch(`${stand.daemonURL}/v1/agents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat: true }),
  })
  const chat = await r.json() as { session_id: string }
  expect(r.ok, JSON.stringify(chat)).toBe(true)
  const { cwd } = await (await fetch(`${stand.daemonURL}/v1/sessions/${chat.session_id}`)).json() as { cwd: string }
  const ARTIFACT = 'https://claude.ai/artifact/XUWK6T8BAtS4msXnSYrbyY'
  const COMMENT = 'https://github.com/dspv/caprock/pull/768#issuecomment-6322183824'
  const reply = `Published: ${ARTIFACT}. The PR comment is ${COMMENT}, and the long one (${LONG_URL}).`
  const dir = path.join(stand.dir, 'home', '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  await new Promise((res) => setTimeout(res, 1000))
  const line = (type: string, n: number, extra: Record<string, unknown>) => JSON.stringify({
    isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: chat.session_id, version: '2.1.296', gitBranch: 'master',
    parentUuid: n > 1 ? `l-${n - 1}` : null, type, uuid: `l-${n}`, timestamp: new Date(Date.now() - 30_000 + n * 1000).toISOString(), ...extra,
  })
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: 'standard' }
  writeFileSync(path.join(dir, `${chat.session_id}.jsonl`), [
    line('user', 1, { promptId: 'p-1', message: { role: 'user', content: [{ type: 'text', text: 'where is it?' }] } }),
    line('assistant', 2, { requestId: 'req-l', message: { model: 'claude-sonnet-4-6', id: 'msg-l', type: 'message', role: 'assistant', content: [{ type: 'text', text: reply }], usage } }),
  ].join('\n') + '\n')

  for (const width of [360, 390, 412]) {
    const { page, close } = await phone(browser, width)
    // Nothing leaves the machine: the tapped address is answered here.
    await page.context().route(/^https:\/\/(claude\.ai|github\.com)\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>opened</title>' }))
    try {
      await page.goto(`${stand.pageURL}/#/chats/${chat.session_id}`)
      // By its href: the ↗ mark (design/tokens.css) is part of the link's name.
      const link = page.locator(`a[href="${ARTIFACT}"]`)
      await expect(link).toBeVisible({ timeout: 20_000 })
      await expect(link).toHaveAttribute('href', ARTIFACT)
      await expect(link).toHaveAttribute('target', '_blank')
      await expect(page.getByRole('link', { name: new RegExp(`^${COMMENT.replace(/[.?#/]/g, '\\$&')}`) })).toHaveAttribute('href', COMMENT)
      await expect(page.locator(`a[href="${LONG_URL}"]`)).toHaveText(LONG_URL)
      const m = await measure(page, width)
      expect(m.scroll, `${width}: ${m.cut.join(' | ')}`).toBeLessThanOrEqual(width)
      expect(m.cut, `${width}`).toEqual([])
      const [opened] = await Promise.all([page.context().waitForEvent('page'), link.tap()])
      await opened.waitForLoadState()
      expect(opened.url()).toBe(ARTIFACT)
      await opened.close()
    } finally {
      await close()
    }
  }
})
