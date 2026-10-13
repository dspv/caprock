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

function serve(f: Footprint) {
  const fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('/v1/footprint') ? { ...f, at: Date.now() } : url.includes('/v1/resources/reap') ? { reaped: [], kept: [] } : undefined
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
    expect(container.querySelector('[data-verdict-summary]')!.textContent).toBe('3 things to look at')
    expect([...container.querySelectorAll('[data-verdict]')].map((e) => e.getAttribute('data-verdict'))).toEqual(['duplicate_daemon', 'orphans', 'disk_reads_high'])
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
    const text = (writeText.mock.calls[0] as unknown as [string])[0]
    expect(text).toBe(footprintText(f)) // `at` is not in the text
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
    await waitFor(() => expect(fetch.mock.calls.filter((c) => String(c[0]).includes('/v1/footprint')).length).toBe(before + 1))
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
