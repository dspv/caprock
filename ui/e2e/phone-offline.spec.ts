/**
 * A phone that loses its network says so, large, and reconnects by itself
 * (owner, 2026-10-21, translated: "When the phone loses network while
 * Caprock is open, I see 'Retry' and 'Pair again' … Pair again is a pain").
 * .ai/04-ui.md § From anywhere, *Why it cannot reach the computer*.
 *
 * The whole path, nothing faked: the phone's page built with --mode remote
 * and served on a free port, `caprock remote relay` on another, the stand's
 * daemon waiting at that relay, and a Pixel-sized headless page that pairs
 * through the link the daemon hands out. Then the page's network is cut
 * with context.setOffline and given back; the computer leaves the relay;
 * the relay goes away; the computer removes the phone — and only the last
 * one offers Pair again.
 *
 * CAPROCK_E2E_SHOTS=<dir> also saves each state at 390 px.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { devices, type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { REPO, UI_DIR } from './stand'

const WIDTHS = [360, 390, 412]
const SHOTS = process.env.CAPROCK_E2E_SHOTS ?? ''

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      s.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))))
    })
  })
}

async function until(what: string, ms: number, ok: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    try {
      if (await ok()) return
    } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1')
    c.once('connect', () => { c.destroy(); resolve(true) })
    c.once('error', () => resolve(false))
  })
}

function stop(p: ChildProcess | undefined): void {
  if (p && p.exitCode === null && p.signalCode === null) p.kill('SIGTERM')
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

/** The notice: large, nothing past the screen's edge, at each phone width. */
async function checkFits(page: Page): Promise<void> {
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 844 })
    const m = await page.evaluate((w) => {
      const card = document.querySelector('[data-testid="connection-problem"]') as HTMLElement
      const px = (sel: string) => parseFloat(getComputedStyle(card.querySelector(sel) as HTMLElement).fontSize)
      const tooWide = [...card.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > w + 0.5).length
      const small = [...card.querySelectorAll('button, summary')].filter((el) => el.getBoundingClientRect().height < 44).length
      return { scroll: document.scrollingElement!.scrollWidth, card: card.getBoundingClientRect().width, h1: px('h1'), body: px('p'), tooWide, small }
    }, w)
    expect(m.scroll, `no sideways scroll at ${w}`).toBeLessThanOrEqual(w)
    expect(m.tooWide, `nothing cut off at ${w}`).toBe(0)
    expect(m.card, `full width at ${w}`).toBeGreaterThanOrEqual(w - 1)
    expect(m.h1).toBeGreaterThanOrEqual(24)
    expect(m.body).toBeGreaterThanOrEqual(18)
    expect(m.small, `targets of 44 px at ${w}`).toBe(0)
  }
  await page.setViewportSize({ width: 390, height: 844 })
}

test('a phone that loses its network says so, large, reconnects by itself, and offers Pair again only when removed', async ({ browser, stand }) => {
  test.setTimeout(300_000)
  const exe = process.platform === 'win32' ? '.exe' : ''
  const caprock = path.join(REPO, 'bin', `caprock${exe}`)
  const out = path.join(stand.dir, 'ui-remote')
  const vite = path.join(UI_DIR, 'node_modules', '.bin', 'vite')
  const b = spawnSync(vite, ['build', '--mode', 'remote', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], { cwd: UI_DIR, encoding: 'utf8' })
  if (b.status !== 0) throw new Error(`remote build failed:\n${b.stdout}\n${b.stderr}`)

  const rport = await freePort()
  const pport = await freePort()
  const relayURL = `ws://127.0.0.1:${rport}`
  const pageURL = `http://127.0.0.1:${pport}`
  let relay: ChildProcess | undefined
  let preview: ChildProcess | undefined
  const startRelay = async () => {
    const log = openSync(path.join(stand.dir, 'relay.log'), 'a')
    // env -i: the relay sees nothing of the caller's environment.
    relay = spawn('env', ['-i', `HOME=${path.join(stand.dir, 'home')}`, `TMPDIR=${path.join(stand.dir, 'tmp')}`, caprock, 'remote', 'relay', '--addr', `127.0.0.1:${rport}`],
      { stdio: ['ignore', log, log] })
    closeSync(log)
    await until('relay listening', 15_000, () => listening(rport))
  }
  const daemon = (method: string, p: string, body?: unknown) => fetch(`${stand.daemonURL}${p}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const remote = async (on: boolean) => {
    const r = await daemon('POST', '/v1/pair/remote', { on, relay: relayURL, app: `${pageURL}/` })
    if (!r.ok) throw new Error(`remote ${on}: ${r.status} ${await r.text()}`)
    if (on) {
      await until('the computer waits at the relay', 20_000, async () => {
        const st = await (await daemon('GET', '/v1/pair/state')).json() as { remote?: { status?: string } }
        return st.remote?.status === 'online'
      })
    }
  }
  const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } })
  try {
    await startRelay()
    const plog = openSync(path.join(stand.dir, 'preview-remote.log'), 'a')
    preview = spawn(vite, ['preview', '--outDir', out, '--host', '127.0.0.1', '--port', String(pport), '--strictPort'],
      { cwd: UI_DIR, env: { ...process.env, CAPROCK_DAEMON_URL: stand.daemonURL }, stdio: ['ignore', plog, plog] })
    closeSync(plog)
    await until('the phone page is served', 20_000, async () => (await fetch(`${pageURL}/favicon.svg`)).ok)
    await remote(true)

    const code = await (await daemon('POST', '/v1/pair/code')).json() as { remote?: { link?: string } }
    const link = code.remote?.link
    expect(link, 'the daemon hands out a link through the relay').toBeTruthy()

    const page = await ctx.newPage()
    await page.goto(link!)
    // Once after pairing: what is done and what is left.
    await page.getByRole('button', { name: 'Open sessions' }).click({ timeout: 30_000 })
    const dash = page.getByTestId('remote-dashboard')
    const notice = page.getByTestId('connection-problem')
    await expect(dash).toBeVisible()
    await expect(notice).toHaveCount(0)

    // (a) The phone's own network goes: said at once, large, never Pair again,
    // and the last screen stays under it, dimmed.
    await ctx.setOffline(true)
    await expect(notice).toHaveAttribute('data-cause', 'offline', { timeout: 5_000 })
    await expect(notice.getByRole('heading')).toHaveText('No internet on this phone')
    await expect(notice).toContainText('Reconnects by itself when the network is back.')
    await expect(page.getByTestId('retry-line')).toHaveText(/^(Trying now…|Next try in \d+ s · attempt \d+)$/)
    await expect(page.getByRole('button', { name: 'Pair again', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Retry now' })).toBeVisible()
    await expect(dash).toHaveAttribute('data-stale', '')
    await expect(page.getByTestId('stale-line')).toContainText('Below: what this phone last had, updated')
    await checkFits(page)
    await shot(page, '1-no-internet')

    // The network comes back: reconnected with no tap.
    await ctx.setOffline(false)
    await expect(notice).toHaveCount(0, { timeout: 15_000 })
    await expect(dash).not.toHaveAttribute('data-stale', '')
    await shot(page, '0-connected')

    // (b) The computer leaves the relay: the computer, not the phone.
    await remote(false)
    await expect(notice).toHaveAttribute('data-cause', 'computer', { timeout: 60_000 })
    await expect(notice.getByRole('heading')).toHaveText('Your computer isn’t answering')
    await expect(page.getByRole('button', { name: 'Pair again', exact: true })).toHaveCount(0)
    await checkFits(page)
    await shot(page, '2-computer-not-answering')
    await remote(true)
    await page.getByRole('button', { name: 'Retry now' }).click({ timeout: 5_000 }).catch(() => { /* already trying */ })
    await expect(notice).toHaveCount(0, { timeout: 40_000 })

    // The relay itself goes: the phone has a network, the relay does not answer.
    stop(relay)
    await expect(notice).toHaveAttribute('data-cause', 'relay', { timeout: 60_000 })
    await expect(notice.getByRole('heading')).toHaveText('Can’t reach the relay')
    await expect(page.getByRole('button', { name: 'Pair again', exact: true })).toHaveCount(0)
    await shot(page, '3-relay-unreachable')
    await startRelay()
    await until('the computer back at the relay', 40_000, async () => {
      const st = await (await daemon('GET', '/v1/pair/state')).json() as { remote?: { status?: string } }
      return st.remote?.status === 'online'
    })
    await page.getByRole('button', { name: 'Retry now' }).click({ timeout: 5_000 }).catch(() => { /* already trying */ })
    await expect(notice).toHaveCount(0, { timeout: 40_000 })

    // (c) The computer removes the phone: the one case that offers Pair again.
    const st = await (await daemon('GET', '/v1/pair/state')).json() as { devices?: { id: string }[] }
    for (const d of st.devices ?? []) {
      const r = await daemon('DELETE', `/v1/pair/devices/${d.id}`)
      expect(r.ok).toBe(true)
    }
    await expect(notice).toHaveAttribute('data-cause', 'unpaired', { timeout: 60_000 })
    await expect(notice.getByRole('heading')).toHaveText('This phone was removed')
    await expect(notice.getByRole('button', { name: 'Pair again', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry now' })).toHaveCount(0)
    await checkFits(page)
    await shot(page, '4-removed-pair-again')
  } finally {
    await ctx.close()
    await daemon('POST', '/v1/pair/remote', { on: false }).catch(() => {})
    stop(preview)
    stop(relay)
  }
})
