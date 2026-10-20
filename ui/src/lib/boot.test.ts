import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The start-up watchdog in index.html (.ai/04-ui.md § A page that never
// starts), run here as the page runs it, with `location` and `fetch` handed in.
const ui = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const html = readFileSync(join(ui, 'index.html'), 'utf8')
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '')
const watchdog = scripts.find((s) => s.includes('caprock.boot.reloads'))!

interface Run { reload: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn>; up: { v: boolean } }

function start(up = false): Run {
  const run: Run = { reload: vi.fn(), fetch: vi.fn(), invoke: vi.fn(() => Promise.resolve()), up: { v: up } }
  run.fetch.mockImplementation(() => run.up.v ? Promise.resolve({ ok: true }) : Promise.reject(new TypeError('Load failed')))
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: run.invoke }
  new Function('location', 'fetch', watchdog)({ reload: run.reload, origin: 'http://127.0.0.1:4173' }, run.fetch)
  return run
}

/** The message of the first line the watchdog wrote to the app's log. */
const told = (run: Run) => (run.invoke.mock.calls[0]?.[1] as { message: string } | undefined)?.message ?? ''

const panel = () =>document.getElementById('caprock-boot')
const draw = () => { document.getElementById('root')!.appendChild(document.createElement('div')) }

beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
  document.body.innerHTML = '<div id="root"></div>'
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('the start-up watchdog', () => {
  it('is in index.html, apart from the pre-paint script', () => {
    expect(watchdog).toBeTruthy()
    expect(scripts[0]).toContain('caprock-theme')
  })

  it('does nothing when the page draws in time', async () => {
    const run = start(true)
    draw()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(panel()).toBeNull()
    expect(run.fetch).not.toHaveBeenCalled()
    expect(run.reload).not.toHaveBeenCalled()
  })

  it('shows Reconnecting while the daemon is away and reloads once it answers', async () => {
    const run = start(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(panel()?.textContent).toContain('Reconnecting to Caprock')
    expect(panel()?.querySelector('button')?.textContent).toBe('Reload')
    expect(run.reload).not.toHaveBeenCalled()
    // Told once, to the app's own log.
    expect(run.invoke).toHaveBeenCalledTimes(1)
    expect(run.invoke.mock.calls[0]?.[0]).toBe('app_log')
    expect(told(run)).toMatch(/drew nothing within 10 s/)
    run.up.v = true
    await vi.advanceTimersByTimeAsync(40_000)
    expect(run.reload).toHaveBeenCalledTimes(1)
    expect(JSON.parse(sessionStorage.getItem('caprock.boot.reloads')!)).toHaveLength(1)
  })

  it('reloads at once when a file of the page did not load and the daemon answers', async () => {
    const run = start(true)
    const s = document.createElement('script')
    s.src = 'http://127.0.0.1:4173/assets/index-abc.js'
    document.head.appendChild(s)
    s.dispatchEvent(new Event('error'))
    await vi.advanceTimersByTimeAsync(1_600)
    expect(run.reload).toHaveBeenCalledTimes(1)
    expect(told(run)).toContain('a file did not load: /assets/index-abc.js')
    s.remove()
  })

  it('stops reloading by itself after five times in ten minutes, and keeps the button', async () => {
    const now = Date.now()
    sessionStorage.setItem('caprock.boot.reloads', JSON.stringify([1, 2, 3, 4, 5].map((i) => now - i * 1000)))
    const run = start(true)
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom' }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run.reload).not.toHaveBeenCalled()
    expect(panel()?.textContent).toContain('did not finish loading')
    panel()!.querySelector('button')!.click()
    expect(run.reload).toHaveBeenCalledTimes(1)
  })

  it('goes away when the page draws after all', async () => {
    start(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(panel()).not.toBeNull()
    draw()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(panel()).toBeNull()
  })

  it('catches a page that empties after it was drawn', async () => {
    const run = start(true)
    draw()
    await vi.advanceTimersByTimeAsync(10_000)
    document.getElementById('root')!.replaceChildren()
    await vi.advanceTimersByTimeAsync(3_100)
    expect(run.reload).toHaveBeenCalledTimes(1)
    expect(told(run)).toContain('emptied after it was drawn')
  })
})
