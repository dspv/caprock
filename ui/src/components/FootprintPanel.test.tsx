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
    verdicts: [{ level: 'ok', code: 'ok', text: 'Nothing here looks wrong.' }],
  }
}

/** The last footprint served, `at` and all: ages in the report count from it. */
let lastServed: Footprint | undefined
/** The bodies POSTed to the orphan stop. */
let stopBodies: unknown[] = []

function serve(f: Footprint) {
  stopBodies = []
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    let body: unknown
    if (url.includes('/v1/footprint/orphans/stop')) {
      const req = JSON.parse(String(init?.body)) as { targets: { pid: number }[] }
      stopBodies.push(req)
      const list = f.orphans?.list ?? []
      body = { stopped: list.filter((o) => req.targets.some((t) => t.pid === o.pid)), failed: [] }
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
  it('opens on a click and lists what memory and disk are spent on', async () => {
    const { button, container } = await strip(warned())
    fireEvent.click(button)
    const panel = screen.getByRole('dialog', { name: 'Caprock on this computer' })
    expect(panel.textContent).toContain('doctor')
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
  })

  it('says the verdict in one line, the warnings, and the duplicates behind them', async () => {
    const { button, container } = await strip(warned())
    fireEvent.click(button)
    expect(container.querySelector('[data-verdict-summary]')!.textContent).toBe('4 things to look at')
    expect([...container.querySelectorAll('[data-verdict]')].map((e) => e.getAttribute('data-verdict'))).toEqual(['duplicate_daemon', 'orphans', 'stray_processes', 'disk_reads_high'])
    const dup = container.querySelector('[data-duplicates]')!.textContent
    expect(dup).toContain('pid 9214')
    expect(dup).toContain('/opt/homebrew/bin/caprock')
    expect(container.querySelector('[data-actions]')!.textContent).toContain('stopped 3 orphaned terminal holders')
  })

  it('says All good when nothing warns', async () => {
    const { button, container } = await strip(healthy())
    fireEvent.click(button)
    expect(container.querySelector('[data-verdict-summary]')!.textContent).toContain('All good')
    expect(container.querySelector('[data-warnings]')).toBeNull()
  })

  it('closes on Escape', async () => {
    const { button } = await strip(warned())
    fireEvent.click(button)
    fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens from the palette\'s Caprock doctor', async () => {
    await strip(warned())
    act(() => openCaprockDoctor())
    expect(screen.getByRole('dialog', { name: 'Caprock on this computer' })).toBeTruthy()
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
    expect(text).toContain('Orphans (processes that look abandoned)')
    expect(text).toContain('Memory and CPU')
    expect(screen.getByRole('status').textContent).toBe('Report copied.')
  })

  it('asks again at once on Check now', async () => {
    const { button, container } = await strip(warned())
    const fetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fireEvent.click(button)
    const before = fetch.mock.calls.filter((c) => String(c[0]).includes('/v1/footprint')).length
    fireEvent.click(container.querySelector('[data-check-now]')!)
    expect(container.querySelector('[data-checked]')!.textContent).toBe('checking…')
    // The strip's question and the open panel's, with the orphan list.
    await waitFor(() => expect(fetch.mock.calls.filter((c) => String(c[0]).includes('/v1/footprint')).length).toBe(before + 2))
    await waitFor(() => expect(container.querySelector('[data-checked]')!.textContent).toBe('checked just now'))
  })
})

describe('Stop N orphans', () => {
  it('is offered to the owner while some can be stopped', async () => {
    const { button } = await strip(warned())
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: 'Stop 11 orphans' })).toBeTruthy()
  })

  it('is not offered on a paired device', async () => {
    const { button } = await strip(warned(), false)
    fireEvent.click(button)
    expect(screen.queryByRole('button', { name: /^Stop / })).toBeNull()
  })

  it('is not offered when there is nothing to stop', async () => {
    const { button } = await strip(healthy())
    fireEvent.click(button)
    expect(screen.queryByRole('button', { name: /^Stop / })).toBeNull()
  })
})

describe('Orphans', () => {
  const open = async (owner = true) => {
    const r = await strip(warned(), owner)
    fireEvent.click(r.button)
    await waitFor(() => expect(r.container.querySelector('[data-orphan]')).not.toBeNull())
    return r
  }

  it('lists each process that looks abandoned with why, its age and memory, read-only by default', async () => {
    const { container } = await open()
    const rows = [...container.querySelectorAll('[data-orphan]')]
    expect(rows.map((r) => r.getAttribute('data-orphan'))).toEqual(['34399', '48120', '48133'])
    const claude = container.querySelector('[data-orphan="48120"]')!.textContent!
    expect(claude).toContain('claude')
    expect(container.querySelector('[data-orphan="48120"] [title="how long it has run"]')!.textContent).toMatch(/^[0-9]+[hd]$/)
    expect(claude).toContain('212 MB')
    expect(claude).toContain('session ended')
    expect(container.querySelector('[data-orphan="34399"]')!.textContent).toContain('(gone)')
    // Off by default: no Stop, no checkbox.
    expect(container.querySelector('[data-advanced]')).not.toBeNull()
    expect((container.querySelector('[data-advanced]') as HTMLInputElement).checked).toBe(false)
    expect(container.querySelector('[data-orphan-stop]')).toBeNull()
    expect(container.querySelector('[data-orphan-pick]')).toBeNull()
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
    const sec = r.container.querySelector('[data-orphans]')!
    expect(sec.textContent).toContain('3 processes at the last check')
    expect(r.container.querySelector('[data-orphan]')).toBeNull()
  })

  it('says so when nothing looks abandoned', async () => {
    const f = healthy()
    f.orphans = { scanned: true, at: f.at, count: 0, by_kind: {}, list: [] }
    const r = await strip(f)
    fireEvent.click(r.button)
    await waitFor(() => expect(r.container.querySelector('[data-orphans-none]')).not.toBeNull())
    expect(r.container.querySelector('[data-advanced]')).toBeNull()
  })

  it('has no Advanced mode on a paired device', async () => {
    const { container } = await open(false)
    expect(container.querySelector('[data-advanced]')).toBeNull()
    expect(container.querySelector('[data-orphan-stop]')).toBeNull()
  })

  it('stops one only after Advanced, Stop and the confirmation, naming its pid and start', async () => {
    const { container } = await open()
    fireEvent.click(container.querySelector('[data-advanced]')!)
    const row = container.querySelector('[data-orphan="48120"]')!
    fireEvent.click(row.querySelector('[data-orphan-stop]')!)
    expect(stopBodies).toEqual([]) // nothing yet: the confirmation first
    const confirm = container.querySelector('[data-stop-confirm]')!
    expect(confirm.textContent).toContain('claude (pid 48120)')
    await act(async () => { fireEvent.click(container.querySelector('[data-stop-confirm-yes]')!) })
    await waitFor(() => expect(stopBodies).toHaveLength(1))
    expect(stopBodies[0]).toEqual({ targets: [{ pid: 48120, started_at: warned().orphans!.list![1]!.started_at }] })
    await waitFor(() => expect(container.querySelector('[data-orphans-note]')!.textContent).toContain('Stopped claude (pid 48120)'))
  })

  it('cancels without stopping anything', async () => {
    const { container } = await open()
    fireEvent.click(container.querySelector('[data-advanced]')!)
    fireEvent.click(container.querySelector('[data-orphan="48133"] [data-orphan-stop]')!)
    fireEvent.click(container.querySelector('[data-stop-confirm-no]')!)
    expect(container.querySelector('[data-stop-confirm]')).toBeNull()
    expect(stopBodies).toEqual([])
  })

  it('stops the selected ones together', async () => {
    const { container } = await open()
    fireEvent.click(container.querySelector('[data-advanced]')!)
    const selected = container.querySelector<HTMLButtonElement>('[data-stop-selected]')!
    expect(selected.disabled).toBe(true)
    fireEvent.click(container.querySelector('[data-orphan="48120"] [data-orphan-pick]')!)
    fireEvent.click(container.querySelector('[data-orphan="48133"] [data-orphan-pick]')!)
    expect(selected.textContent).toBe('Stop selected (2)')
    fireEvent.click(selected)
    expect(container.querySelector('[data-stop-confirm]')!.textContent).toContain('Stop 2 processes?')
    await act(async () => { fireEvent.click(container.querySelector('[data-stop-confirm-yes]')!) })
    await waitFor(() => expect(stopBodies).toHaveLength(1))
    expect((stopBodies[0] as { targets: { pid: number }[] }).targets.map((t) => t.pid)).toEqual([48120, 48133])
  })
})
