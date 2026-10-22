/**
 * Private modules (ADR-076): nothing is drawn without a valid admin key; with
 * one, each installed module gets a sidebar row and a route; a CRA1 key pasted
 * into the licence field goes to /v1/admin and never into settings.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRAIN_FOLD_KEY, MODULE_FOLD_KEY, setBrainFold } from './sidebarAccordion'
import { href, parseHash } from './router'
import { ModuleRows } from '@/components/ModuleRows'
import { LicenseField } from '@/components/LicenseField'
import type { AdminState, ModuleAttention, Settings } from './api'

function stubFetch(admin: AdminState, onPut?: (body: unknown) => AdminState) {
  const calls: { method: string; url: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    let out: unknown = {}
    if (url === '/v1/admin') out = method === 'PUT' && onPut ? onPut(body) : admin
    if (url === '/v1/premium') out = { license: { active: false, reason: 'no key' } }
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('the module route', () => {
  it('reads #/x/<id> and writes it back; anything that is not an id is Home', () => {
    expect(parseHash('#/x/alpha')).toEqual({ name: 'module', id: 'alpha' })
    expect(href({ name: 'module', id: 'alpha' })).toBe('#/x/alpha')
    expect(parseHash('#/x/..')).toEqual({ name: 'now' })
    expect(parseHash('#/x/')).toEqual({ name: 'now' })
    expect(parseHash('#/x/Alpha')).toEqual({ name: 'now' })
  })

  it('carries a route inside the module, and only a #route', () => {
    expect(parseHash('#/x/alpha?to=%23review%2F42')).toEqual({ name: 'module', id: 'alpha', to: '#review/42' })
    expect(href({ name: 'module', id: 'alpha', to: '#review/42' })).toBe('#/x/alpha?to=%23review%2F42')
    expect(parseHash('#/x/alpha?to=https%3A%2F%2Fexample.com')).toEqual({ name: 'module', id: 'alpha' })
    expect(parseHash('#/x/alpha?to=%23')).toEqual({ name: 'module', id: 'alpha' })
  })
})

const ops = (attention?: ModuleAttention): AdminState => ({
  admin: true, modules: ['ops'], installed: [{ id: 'ops', name: 'Ops', url: '/x/ops/', ...(attention ? { attention } : {}) }],
})
const two = { count: 2, updated_at: Date.now(), items: [{ label: 'Review PR 42', href: '#review/42' }, { label: 'Approve deploy', href: '#deploy' }] }

describe('what waits in a module', () => {
  it('draws no informer at 0: the row is as it always was', async () => {
    stubFetch(ops({ count: 0, items: [], updated_at: Date.now() }))
    render(<ModuleRows onOpen={vi.fn()} dashboardActive />)
    const row = await screen.findByRole('button', { name: /Ops/ })
    expect(document.querySelector('[data-module-attention]')).toBeNull()
    expect(document.querySelector('[data-module-chip]')).toBeNull()
    expect(row).toHaveClass('h-[32px]', 'border')
  })

  it('draws none for a report over a day old', async () => {
    stubFetch(ops({ ...two, updated_at: Date.now() - 25 * 3600_000 }))
    render(<ModuleRows onOpen={vi.fn()} dashboardActive />)
    await screen.findByRole('button', { name: /Ops/ })
    expect(document.querySelector('[data-module-attention]')).toBeNull()
  })

  it('shows a small count inside the row, and unfolds into the items, each opening its route', async () => {
    stubFetch(ops(two))
    const onOpen = vi.fn()
    render(<ModuleRows onOpen={onOpen} dashboardActive />)
    const info = await screen.findByRole('button', { name: '2 waiting in Ops' })
    expect(info.textContent).toBe('2 waiting')
    expect(info).toHaveClass('text-warn')
    expect(info.closest('[data-module-chip="ops"]')).not.toBeNull()
    expect(info).toHaveAttribute('aria-expanded', 'false')
    expect(document.querySelector('[data-module-items]')).toBeNull()

    fireEvent.click(info)
    expect(info).toHaveAttribute('aria-expanded', 'true')
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-module-item]'))
    expect(items.map((b) => b.textContent)).toEqual(['Review PR 42', 'Approve deploy'])
    fireEvent.click(items[0]!)
    expect(onOpen).toHaveBeenCalledWith('#/x/ops?to=%23review%2F42')
    // The row itself still opens the module.
    fireEvent.click(screen.getByRole('button', { name: /^Ops/ }))
    expect(onOpen).toHaveBeenLastCalledWith('#/x/ops')
  })

  it('opens the module from the informer when nothing is named', async () => {
    stubFetch(ops({ count: 3, items: [], updated_at: Date.now() }))
    const onOpen = vi.fn()
    render(<ModuleRows onOpen={onOpen} dashboardActive />)
    fireEvent.click(await screen.findByRole('button', { name: '3 waiting in Ops' }))
    expect(onOpen).toHaveBeenCalledWith('#/x/ops')
    expect(document.querySelector('[data-module-items]')).toBeNull()
  })

  it('is an accordion with Second Brain: unfolding one folds the other, kept in this browser', async () => {
    localStorage.setItem(BRAIN_FOLD_KEY, 'open')
    stubFetch(ops(two))
    render(<ModuleRows onOpen={vi.fn()} dashboardActive />)
    fireEvent.click(await screen.findByRole('button', { name: '2 waiting in Ops' }))
    expect(localStorage.getItem(BRAIN_FOLD_KEY)).toBe('closed')
    expect(localStorage.getItem(MODULE_FOLD_KEY)).toBe('ops')
    expect(document.querySelector('[data-module-items]')).not.toBeNull()

    act(() => setBrainFold(true))
    expect(document.querySelector('[data-module-items]')).toBeNull()
    expect(localStorage.getItem(MODULE_FOLD_KEY)).toBeNull()
    expect(screen.getByRole('button', { name: '2 waiting in Ops' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('asks for the admin state again on an admin frame', async () => {
    const calls = stubFetch(ops())
    render(<ModuleRows onOpen={vi.fn()} dashboardActive />)
    await screen.findByRole('button', { name: /Ops/ })
    const before = calls.filter((c) => c.url === '/v1/admin').length
    const { live } = await import('./live')
    act(() => { live.handle({ type: 'admin', data: {} }) })
    await waitFor(() => expect(calls.filter((c) => c.url === '/v1/admin').length).toBeGreaterThan(before))
  })
})

describe('the sidebar rows', () => {
  it('draws nothing without a key', async () => {
    const calls = stubFetch({ admin: false })
    const { container } = render(<ModuleRows onOpen={vi.fn()} dashboardActive />)
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/admin')).toBe(true))
    expect(container.innerHTML).toBe('')
  })

  it('draws a row per installed module the key opens, and opens its route', async () => {
    stubFetch({ admin: true, modules: ['alpha'], installed: [{ id: 'alpha', name: 'Alpha', url: '/x/alpha/' }] })
    const onOpen = vi.fn()
    render(<ModuleRows onOpen={onOpen} dashboardActive />)
    const row = await screen.findByRole('button', { name: /Alpha/ })
    // Its key is drawn on the row: ⇧⌘1 on a Mac, Ctrl+Alt+Shift+1 elsewhere.
    expect(row.querySelector('[data-key-chip]')?.textContent).toMatch(/^(⇧⌘1|Ctrl\+Alt\+Shift\+1)$/)
    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith('#/x/alpha')
  })
})

describe('the licence field', () => {
  const plan = { license_key: '' } as Settings

  it('sends a CRA1 key to /v1/admin, not to settings, and says it is on', async () => {
    const calls = stubFetch({ admin: false }, () => ({ admin: true, modules: ['alpha'], installed: [] }))
    const save = vi.fn()
    render(<LicenseField plan={plan} save={save} />)
    fireEvent.change(screen.getByLabelText('Licence key'), { target: { value: ' CRA1.abc.def ' } })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    await screen.findByText(/Admin key is on — alpha/)
    expect(save).not.toHaveBeenCalled()
    expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', url: '/v1/admin', body: { key: 'CRA1.abc.def' } })
  })

  it('says nothing about admin keys to someone without one', async () => {
    const calls = stubFetch({ admin: false })
    render(<LicenseField plan={plan} save={vi.fn()} />)
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/admin')).toBe(true))
    expect(document.body.textContent).not.toMatch(/admin|module/i)
  })

  it('still saves a Premium key as before', () => {
    stubFetch({ admin: false })
    const save = vi.fn()
    render(<LicenseField plan={plan} save={save} />)
    fireEvent.change(screen.getByLabelText('Licence key'), { target: { value: 'CR-2027-01-01-ABCDEF12' } })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    expect(save).toHaveBeenCalledWith({ license_key: 'CR-2027-01-01-ABCDEF12' })
  })
})
