import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LanOnlyNotice } from './LanOnlyNotice'
import { api, clearDeviceToken, setDeviceToken } from '@/lib/api'

describe('LanOnlyNotice — a phone on the Wi-Fi link (owner, 2026-10-14)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    clearDeviceToken()
  })

  it('with access from anywhere on, calls this the old Wi-Fi link and names the app to use instead', async () => {
    setDeviceToken('t')
    vi.spyOn(api, 'pairMe').mockResolvedValue({ role: 'viewer', via: 'lan', anywhere: true, app: 'https://m.caprock.dev' })
    render(<LanOnlyNotice />)
    const note = await screen.findByTestId('lan-only-notice')
    expect(note.textContent).toMatch(
      /^This is the old Wi-Fi link: it works only on your home Wi-Fi\. Use the Caprock app from m\.caprock\.dev instead: in the Caprock app on your computer, Settings → Use on your phone → Show a code, and scan it\. Then remove this one from your home screen\./,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByTestId('lan-only-notice')).toBeNull()
  })

  it('with access from anywhere still off, says the code turns it on', async () => {
    setDeviceToken('t')
    vi.spyOn(api, 'pairMe').mockResolvedValue({ role: 'viewer', via: 'lan' })
    render(<LanOnlyNotice />)
    const note = await screen.findByTestId('lan-only-notice')
    expect(note.textContent).toMatch(/^This link works only on your home Wi-Fi\. To use Caprock anywhere: in the Caprock app on your computer, Settings → Use on your phone → Show a code, and scan it\./)
  })

  it('is silent through the relay, over Tailscale, and on the machine itself', async () => {
    setDeviceToken('t')
    const me = vi.spyOn(api, 'pairMe').mockResolvedValue({ role: 'viewer', via: 'relay', anywhere: true })
    render(<LanOnlyNotice />)
    await vi.waitFor(() => expect(me).toHaveBeenCalled())
    expect(screen.queryByTestId('lan-only-notice')).toBeNull()
    cleanup()
    me.mockResolvedValue({ role: 'viewer', via: 'tailscale' })
    render(<LanOnlyNotice />)
    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('lan-only-notice')).toBeNull()
    cleanup()
    clearDeviceToken()
    render(<LanOnlyNotice />)
    expect(me).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('lan-only-notice')).toBeNull()
  })
})
