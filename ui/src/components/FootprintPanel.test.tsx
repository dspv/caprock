/**
 * Caprock's own cost on the status strip and the panel behind it. The owner
 * asked (2026-10-13, translated): show the memory Caprock takes and what it is
 * spent on, so a user can tell at a glance whether a slowdown is Caprock; and
 * disk.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CaprockFootprint, openCaprockDoctor } from './FootprintPanel'
import { footprintText, type Footprint } from '@/lib/footprint'
import { resetResourcesForTest } from '@/lib/resources'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const warned = (): Footprint => JSON.parse(readFileSync(join(repo, 'testdata', 'footprint', 'doctor.json'), 'utf8')) as Footprint

function healthy(): Footprint {
  const f = warned()
  return {
    ...f,
    memory: { ...f.memory, hosts: { count: 6, mem_bytes: 200 * 2 ** 20, cpu_pct: 0, orphans: 0, reapable: 0 }, other_daemons_mem_bytes: 0, total_mem_bytes: 2 ** 30 },
    duplicates: { ...f.duplicates, daemons: [], other_install_holders: { count: 0, orphans: 0, exes: [] } },
    orphans: { scanned: true, at: f.at, count: 0, by_kind: {}, mem_bytes: 0, list: [] },
    verdicts: [{ level: 'ok', code: 'ok', text: 'Nothing here looks wrong.' }],
  }
}

/** The last footprint served, `at` and all: ages in the report count from it. */
let lastServed: Footprint | undefined
/** The bodies POSTed to the orphan stop. */
let stopBodies: unknown[] = []
/** Pids that ignore SIGTERM: a stop without force reports them running. */
let stubborn = new Set<number>()

function serve(f: Footprint) {
  stopBodies = []
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    let body: unknown
    if (url.includes('/v1/footprint/orphans/stop')) {
      const req = JSON.parse(String(init?.body)) as { targets: { pid: number }[]; force?: boolean }
      stopBodies.push(req)
      const named = (f.orphans?.list ?? []).filter((o) => req.targets.some((t) => t.pid === o.pid))
      const holdsOut = (pid: number) => !req.force && stubborn.has(pid)
      body = { stopped: named.filter((o) => !holdsOut(o.pid)), running: named.filter((o) => holdsOut(o.pid)), failed: [] }
    } else if (url.includes('/v1/footprint')) {
      // The strip asks without the list; the open panel with it.
      const withList = url.includes('orphans=1')
      lastServed = { ...f, at: Date.now(), orphans: f.orphans && (withList ? f.orphans : { ...f.orphans, scanned: false, list: [] }) }
      body = lastServed
    } else if (url.includes('/v1/resources/reap')) body = { reaped: [], kept: [] }
    if (!body) return new Promise<Response>(() => {})
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => {
  stubborn = new Set()
  act(() => resetResourcesForTest())
  vi.unstubAllGlobals()
})

async function strip(f: Footprint, owner = true) {
  serve(f)
  const r = render(<CaprockFootprint owner={owner} />)
  const button = await waitFor(() => {
    const b = r.container.querySelector<HTMLButtonElement>('button[data-caprock-load]')
    if (!b) throw new Error('not yet')
    return b
  })
  return { ...r, button }
}

describe('the status figure', () => {
  it('says memory then disk, muted while nothing warns', async () => {
    const { button } = await strip(healthy())
    expect(button.textContent).toBe('caprock 1.0 GB·2.2 GB')
    expect(button.className).toContain('text-fg-muted')
    expect(button.className).not.toContain('text-warn')
    expect(button.querySelector('[data-warn-dot]')).toBeNull()
  })

  it('counts the orphans on the strip, and says their memory in the doctor', async () => {
    const { button, container } = await strip(warned())
    expect(button.querySelector('[data-orphan-figure]')!.textContent).toBe('4 orphans')
    expect(button.getAttribute('title')).toContain('Orphans: 4 · 325 MB')
    fireEvent.click(button)
    expect(container.querySelector('[data-orphan-summary]')!.textContent).toBe('4 processes to review · 325 MB')
    // Details: the command line, credentials hidden, and the CPU when there is a rate.
    await waitFor(() => expect(container.querySelector('[data-orphan="48120"]')).not.toBeNull())
    const claude = container.querySelector('[data-orphan="48120"]')!
    expect(claude.querySelector('[data-orphan-cmd]')!.textContent).toBe('$ claude --session-id 2f6c --api-key [hidden] -p "summarise the logs"')
    expect(claude.textContent).toContain('0.1% CPU')
  })

  it('says memory alone in a narrow window, the disk in the tooltip, and keeps the warning dot', async () => {
    vi.stubGlobal('matchMedia', vi.fn((q: string) => ({ matches: q.includes('max-width'), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    const { button } = await strip(warned())
    expect(button.textContent).toBe('caprock 1.1 GB')
    expect(button.querySelector('[data-disk-figure]')).toBeNull()
    expect(button.title).toContain('2.2 GB on disk')
    expect(button.querySelector('[data-warn-dot]')).not.toBeNull()
  })

  it('turns the warning colour, with a dot, when a verdict warns', async () => {
    const { button } = await strip(warned())
    expect(button).toHaveAttribute('data-warn')
    expect(button.className).toContain('text-warn')
    expect(button.querySelector('[data-warn-dot]')).not.toBeNull()
    expect(button.title).toContain('11 of 26 terminal holders are orphans')
  })

  it('falls back to the meter\'s memory for a daemon without the footprint', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"error":"not found"}', { status: 404 }))))
    act(() => resetResourcesForTest({
      at: Date.now(), sessions: [],
      caprock: { daemon: { pid: 1, name: 'caprock', cpu_pct: 1, mem_bytes: 300 * 2 ** 20 }, webview: { count: 2, cpu_pct: 1, mem_bytes: 100 * 2 ** 20, procs: [] }, hosts: { count: 0, mem_bytes: 0, cpu_pct: 0, orphans: 0, reapable: 0, list: [] } },
      thresholds: { cpu_pct: 100, mem_bytes: 2 ** 31, after_s: 60, interval_s: 5 },
    }))
    const { container } = render(<CaprockFootprint owner />)
    await waitFor(() => expect(container.querySelector('[data-caprock-load]')?.textContent).toBe('caprock 400 MB'))
    expect(container.querySelector('button[data-caprock-load]')).toBeNull()
  })
})

describe('the panel', () => {
  it('keeps what memory and disk are spent on behind the breakdown', async () => {
    const { button, container } = await strip(warned())
    fireEvent.click(button)
    expect(container.querySelector('[data-memory]')).toBeNull()
    const toggle = container.querySelector<HTMLButtonElement>('[data-breakdown]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toContain('Resource breakdown')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const row = (k: string) => container.querySelector(`[data-row="${k}"]`)?.textContent ?? ''
    expect(row('daemon')).toContain('340 MB')
    expect(row('window')).toContain('3 web view')
    expect(row('window')).toContain('465 MB')
    expect(row('hosts')).toContain('26')
    expect(row('hosts')).toContain('260 MB')
    expect(row('orphans')).toContain('11')
    expect(row('others')).toContain('33 MB')
    expect(row('db')).toContain('2.0 GB')
    expect(row('pastes')).toContain('120 MB')
    expect(row('bin')).toContain('51 MB')
    expect(row('read')).toContain('1.6 GB')
    expect(row('write')).toContain('22 MB')
    expect(container.querySelector('[data-actions]')!.textContent).toContain('stopped 3 orphaned terminal holders')
  })

  it('says one verdict line and a row per problem, the pids and paths under Details', async () => {
    const { button, container } = await strip(warned())
    fireEvent.click(button)
    expect(container.querySelector('[data-verdict-summary]')!.textContent).toBe('Needs attention')
    await waitFor(() => expect(container.querySelector('[data-doctor-row="claude"]')).not.toBeNull())
    expect([...container.querySelectorAll('[data-doctor-row]')].map((e) => e.getAttribute('data-doctor-row'))).toEqual(['copies', 'terminals', 'claude', 'codex', 'helpers', 'reads'])
    const copies = container.querySelector('[data-doctor-row="copies"]')!
    expect(copies.textContent).toContain('Test copies of Caprock (1)')
    expect(copies.textContent).toContain('Started by agent work, not your app.')
    // Pids and paths are there, one click down.
    const details = copies.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.textContent).toContain('pid 9214')
    expect(details.textContent).toContain('started by: a temporary folder')
    expect(container.querySelector('[data-doctor-row="reads"]')!.textContent).toContain('1.6 GB / hour')
  })

  it('says All good with the memory when nothing warns', async () => {
    const { button, container } = await strip(healthy())
    fireEvent.click(button)
    expect(container.querySelector('[data-verdict-summary]')!.textContent).toContain('All good')
    expect(container.querySelector('[data-cleanup]')).toBeNull()
  })

  it('keeps its tooltip out of the way while the panel is open', async () => {
    const { button } = await strip(warned())
    expect(button.getAttribute('title')).toMatch(/Caprock on this computer/)
    fireEvent.click(button)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(button.hasAttribute('title')).toBe(false)
  })

  it('closes on Escape', async () => {
    const { button } = await strip(warned())
    fireEvent.click(button)
    fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens from the palette\'s Caprock doctor', async () => {
    await strip(warned())
    // The listener is added in an effect once the footprint is in; on a busy
    // CI runner that can land a tick after the button does.
    await waitFor(() => {
      act(() => openCaprockDoctor())
      expect(screen.getByRole('dialog', { name: 'Caprock on this computer' })).toBeTruthy()
    })
  })

  it('copies the report caprock doctor prints', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const f = warned()
    const { button, container } = await strip(f)
    fireEvent.click(button)
    await act(async () => { fireEvent.click(container.querySelector('[data-copy-report]')!) })
    await waitFor(() => expect(container.querySelector('[data-orphan]')).not.toBeNull())
    await act(async () => { fireEvent.click(container.querySelector('[data-copy-report]')!) })
    const text = (writeText.mock.calls.at(-1) as unknown as [string])[0]
    expect(text).toBe(footprintText(lastServed!)) // ages count from the report's `at`
    expect(text).toContain('Orphans: 4 · 325 MB (processes that look abandoned)')
    expect(text).toContain('Memory and CPU')
    expect(screen.getByRole('status').textContent).toBe('Report copied.')
  })

  it('asks again at once on Check now', async () => {
    const { button, container } = await strip(warned())
    const fetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fireEvent.click(button)
    const before = fetch.mock.calls.filter((c) => String(c[0]).includes('/v1/footprint')).length
    fireEvent.click(container.querySelector('[data-check-now]')!)
    expect(container.querySelector('[data-checked]')!.textContent).toBe('Checking…')
    // The strip's question and the open panel's, with the orphan list.
    await waitFor(() => expect(fetch.mock.calls.filter((c) => String(c[0]).includes('/v1/footprint')).length).toBe(before + 2))
    // Check now takes a new scan; the panel's 10-second asks take the daemon's last (up to 30 s old).
    const panelAsks = fetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('orphans=1'))
    expect(panelAsks[0]).not.toContain('fresh=1')
    expect(panelAsks.at(-1)).toContain('orphans=1&fresh=1')
    await waitFor(() => expect(container.querySelector('[data-checked]')!.textContent).toBe('Checked just now'))
  })
})

describe('Clean up and Stop', () => {
  const open = async (owner = true) => {
    const r = await strip(warned(), owner)
    fireEvent.click(r.button)
    await waitFor(() => expect(r.container.querySelector('[data-doctor-row="claude"]')).not.toBeNull())
    return r
  }

  it('offers one Clean up with what it frees, and stops nothing before the list is confirmed', async () => {
    const { container } = await open()
    const clean = container.querySelector<HTMLButtonElement>('[data-cleanup]')!
    expect(clean.textContent).toBe('Clean up (frees ~316 MB)')
    fireEvent.click(clean)
    expect(stopBodies).toEqual([])
    const confirm = container.querySelector('[data-stop-confirm]')!
    // Every process on its own line with its own box; the safe ones ticked.
    const picks = [...confirm.querySelectorAll<HTMLInputElement>('[data-stop-pick]')]
    expect(picks.map((p) => [p.getAttribute('data-stop-pick'), p.checked])).toEqual([['34399', false], ['48120', true], ['48160', true], ['48133', true]])
    expect(confirm.textContent).toContain('Something still runs in it')
    expect(container.querySelector('[data-stop-confirm-yes]')!.textContent).toBe('Stop 3 · frees ~316 MB')
    await act(async () => { fireEvent.click(container.querySelector('[data-stop-confirm-yes]')!) })
    await waitFor(() => expect(stopBodies).toHaveLength(1))
    const started = warned().orphans!.list![1]!.started_at
    expect(stopBodies[0]).toEqual({ targets: [{ pid: 48120, started_at: started }, { pid: 48160, started_at: warned().orphans!.list![2]!.started_at }, { pid: 48133, started_at: started }] })
    await waitFor(() => expect(container.querySelector('[data-doctor-note]')!.textContent).toBe('Stopped 3, about 316 MB freed.'))
  })

  it('stops only what is left ticked', async () => {
    const { container } = await open()
    fireEvent.click(container.querySelector('[data-cleanup]')!)
    fireEvent.click(container.querySelector('[data-stop-pick="48133"]')!)
    fireEvent.click(container.querySelector('[data-stop-pick="48160"]')!)
    await act(async () => { fireEvent.click(container.querySelector('[data-stop-confirm-yes]')!) })
    await waitFor(() => expect(stopBodies).toHaveLength(1))
    expect((stopBodies[0] as { targets: { pid: number }[] }).targets.map((t) => t.pid)).toEqual([48120])
  })

  it('sends SIGKILL only on a second click, for what outlived SIGTERM', async () => {
    stubborn = new Set([48120])
    const { container } = await open()
    fireEvent.click(container.querySelector('[data-doctor-row="claude"] [data-row-stop]')!)
    await act(async () => { fireEvent.click(container.querySelector('[data-stop-confirm-yes]')!) })
    await waitFor(() => expect(container.querySelector('[data-force-stop-box]')).not.toBeNull())
    expect(stopBodies).toHaveLength(1)
    expect((stopBodies[0] as { force?: boolean }).force).toBeUndefined()
    const box = container.querySelector('[data-force-stop-box]')!
    expect(box.querySelector('[data-still-running="48120"]')!.textContent).toContain('Finished Claude session')
    expect(box.querySelector('[data-force-stop]')!.textContent).toBe('Force stop 1')
    await act(async () => { fireEvent.click(box.querySelector('[data-force-stop]')!) })
    await waitFor(() => expect(stopBodies).toHaveLength(2))
    expect(stopBodies[1]).toEqual({ targets: [{ pid: 48120, started_at: warned().orphans!.list![1]!.started_at }], force: true })
    await waitFor(() => expect(container.querySelector('[data-force-stop-box]')).toBeNull())
  })

  it('leaves what outlived SIGTERM running when asked', async () => {
    stubborn = new Set([48120])
    const { container } = await open()
    fireEvent.click(container.querySelector('[data-doctor-row="claude"] [data-row-stop]')!)
    await act(async () => { fireEvent.click(container.querySelector('[data-stop-confirm-yes]')!) })
    await waitFor(() => expect(container.querySelector('[data-force-stop-box]')).not.toBeNull())
    fireEvent.click(screen.getByText('Leave running'))
    expect(container.querySelector('[data-force-stop-box]')).toBeNull()
    expect(stopBodies).toHaveLength(1)
  })

  it('stops one row from its own Stop, after the confirmation', async () => {
    const { container } = await open()
    fireEvent.click(container.querySelector('[data-doctor-row="claude"] [data-row-stop]')!)
    const confirm = container.querySelector('[data-doctor-row="claude"] [data-stop-confirm]')!
    expect(confirm.textContent).toContain('Finished Claude session')
    await act(async () => { fireEvent.click(confirm.querySelector('[data-stop-confirm-yes]')!) })
    await waitFor(() => expect(stopBodies).toHaveLength(1))
    expect((stopBodies[0] as { targets: { pid: number }[] }).targets.map((t) => t.pid)).toEqual([48120])
  })

  it('cancels without stopping anything, with the button or Escape', async () => {
    const { container } = await open()
    fireEvent.click(container.querySelector('[data-cleanup]')!)
    fireEvent.click(container.querySelector('[data-stop-confirm-no]')!)
    expect(container.querySelector('[data-stop-confirm]')).toBeNull()
    fireEvent.click(container.querySelector('[data-cleanup]')!)
    fireEvent.keyDown(container.querySelector('[data-stop-confirm-yes]')!, { code: 'Escape', key: 'Escape' })
    expect(container.querySelector('[data-stop-confirm]')).toBeNull()
    expect(screen.getByRole('dialog')).toBeTruthy() // Escape closed the confirmation, not the panel
    expect(stopBodies).toEqual([])
  })

  it('is not offered on a paired device', async () => {
    const { container } = await open(false)
    expect(container.querySelector('[data-cleanup]')).toBeNull()
    expect(container.querySelector('[data-row-stop]')).toBeNull()
  })

  it('is not offered when there is nothing to stop', async () => {
    const f = healthy()
    f.orphans = { scanned: true, at: f.at, count: 0, by_kind: {}, list: [] }
    const r = await strip(f)
    fireEvent.click(r.button)
    expect(r.container.querySelector('[data-cleanup]')).toBeNull()
    expect(r.container.querySelector('[data-row-stop]')).toBeNull()
  })

  it('shows the last count while the list is being taken', async () => {
    const r = await strip(warned())
    const fetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    // Hold the panel's own question so the strip's counts are what it shows.
    fetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('orphans=1')) return new Promise<Response>(() => {})
      const f = warned()
      return Promise.resolve(new Response(JSON.stringify({ ...f, at: Date.now(), orphans: { ...f.orphans, scanned: false, list: [] } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    })
    fireEvent.click(r.button)
    expect(r.container.querySelector('[data-doctor-row="helpers"]')!.textContent).toContain('Leftover processes (3)')
    expect(r.container.textContent).toContain('Looking for what can be stopped')
    expect(r.container.querySelector('[data-cleanup]')).toBeNull()
  })
})
