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

  it('tells a phone on the Wi-Fi link how to get the link that works anywhere, naming the app and the path', async () => {
    setDeviceToken('t')
    vi.spyOn(api, 'pairMe').mockResolvedValue({ role: 'viewer', via: 'lan', anywhere: true })
    render(<LanOnlyNotice />)
    const note = await screen.findByTestId('lan-only-notice')
    expect(note.textContent).toMatch(/^This link works only on your home Wi-Fi\. To use Caprock anywhere: in the Caprock app on your computer, Settings → Use on your phone → Show a code, and scan it\./)
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByTestId('lan-only-notice')).toBeNull()
  })

  it('says it whether or not access from anywhere is on yet: the code turns it on', async () => {
    setDeviceToken('t')
    vi.spyOn(api, 'pairMe').mockResolvedValue({ role: 'viewer', via: 'lan' })
    render(<LanOnlyNotice />)
    expect(await screen.findByTestId('lan-only-notice')).toBeTruthy()
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
