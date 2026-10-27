/**
 * *Open on my phone* (ADR-087): only for a local dev server's page; a click
 * shares it and shows the QR; while shared the button says so; Stop sharing
 * ends it.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevShare } from '@/lib/api'

const calls = vi.hoisted(() => ({ start: [] as string[], stop: [] as string[], list: [] as DevShare[], fail: '' }))
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>()
  return {
    ...real,
    api: {
      ...real.api,
      devShares: () => Promise.resolve({ shares: calls.list, idle_sec: 1800, max_sec: 28800, max: 3 }),
      startDevShare: (url: string) => {
        calls.start.push(url)
        if (calls.fail) return Promise.reject(new Error(calls.fail))
        return Promise.resolve(share)
      },
      stopDevShare: (id: string) => { calls.stop.push(id); return Promise.resolve({ stopped: true }) },
    },
  }
})

import { OpenOnPhone } from './OpenOnPhone'
import { resetDevShares, shareOrigin } from '@/lib/devshare'

const share: DevShare = {
  id: 'ab12',
  target: 'http://localhost:5173',
  path: '/shop',
  url: 'http://192.168.1.5:54321/__caprock/open/tok',
  address: '192.168.1.5:54321',
  started_at: '2026-10-27T12:00:00Z',
  last_used_at: '2026-10-27T12:00:00Z',
  expires_at: '2026-10-27T12:30:00Z',
}

beforeEach(() => {
  calls.start = []
  calls.stop = []
  calls.list = []
  calls.fail = ''
  resetDevShares()
})
afterEach(() => cleanup())

describe('which pages get the button', () => {
  it('is drawn for a local dev server and nothing else', async () => {
    for (const url of ['http://localhost:5173/', 'http://127.0.0.1:8000/a', 'http://app.localhost:3000', 'http://0.0.0.0:5173']) {
      const { unmount } = render(<OpenOnPhone url={url} />)
      expect(screen.getByRole('button', { name: /Open on my phone/ })).toBeTruthy()
      unmount()
    }
    for (const url of ['', 'https://example.com/', 'http://192.168.1.5:3000/', 'file:///tmp/x.html', 'http://localhost.example.com/']) {
      const { container, unmount } = render(<OpenOnPhone url={url} />)
      expect(container.querySelector('[data-open-on-phone]')).toBeNull()
      unmount()
    }
    await act(async () => {})
  })

  it('reads a share by its origin', () => {
    expect(shareOrigin('http://0.0.0.0:5173/x')).toBe('http://localhost:5173')
    expect(shareOrigin('https://example.com')).toBeNull()
  })
})

describe('sharing', () => {
  it('shares on a click, shows the QR and the Wi-Fi rule, and stops', async () => {
    render(<OpenOnPhone url="http://localhost:5173/shop" />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Open on my phone/ })) })
    expect(calls.start).toEqual(['http://localhost:5173/shop'])
    const sheet = screen.getByRole('dialog', { name: 'Open on your phone' })
    expect(sheet.querySelector('[data-qr-text]')?.getAttribute('data-qr-text')).toBe(share.url)
    expect(sheet.textContent).toContain('the same Wi-Fi')
    expect(sheet.textContent).toContain('192.168.1.5:54321')
    expect(sheet.textContent).toContain('30 minutes unused')
    expect(sheet.textContent).toContain('client isolation')
    // The button says it is on, with its dot.
    const btn = screen.getByRole('button', { name: /On my phone/ })
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn.querySelector('[data-share-dot]')).toBeTruthy()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' })) })
    expect(calls.stop).toEqual(['ab12'])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: /Open on my phone/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('shows a share the daemon already has without starting another', async () => {
    calls.list = [share]
    render(<OpenOnPhone url="http://localhost:5173/" />)
    await act(async () => {})
    const btn = screen.getByRole('button', { name: /On my phone/ })
    await act(async () => { fireEvent.click(btn) })
    expect(calls.start).toEqual([])
    expect(screen.getByRole('dialog').querySelector('[data-qr-text]')).toBeTruthy()
  })

  it('says why it could not share', async () => {
    calls.fail = 'this computer has no address on a local network: is Wi-Fi on?'
    render(<OpenOnPhone url="http://localhost:5173/" />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Open on my phone/ })) })
    expect(screen.getByRole('alert').textContent).toContain('is Wi-Fi on?')
    expect(screen.queryByRole('img')).toBeNull()
  })
})
