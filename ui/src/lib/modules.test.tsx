/**
 * Private modules (ADR-075): nothing is drawn without a valid admin key; with
 * one, each installed module gets a sidebar row and a route; a CRA1 key pasted
 * into the licence field goes to /v1/admin and never into settings.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { href, parseHash } from './router'
import { ModuleRows } from '@/components/ModuleRows'
import { LicenseField } from '@/components/LicenseField'
import type { AdminState, Settings } from './api'

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

afterEach(() => { vi.unstubAllGlobals() })

describe('the module route', () => {
  it('reads #/x/<id> and writes it back; anything that is not an id is Home', () => {
    expect(parseHash('#/x/alpha')).toEqual({ name: 'module', id: 'alpha' })
    expect(href({ name: 'module', id: 'alpha' })).toBe('#/x/alpha')
    expect(parseHash('#/x/..')).toEqual({ name: 'now' })
    expect(parseHash('#/x/')).toEqual({ name: 'now' })
    expect(parseHash('#/x/Alpha')).toEqual({ name: 'now' })
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
    fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }))
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
