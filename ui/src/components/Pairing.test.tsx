import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { Pairing, TAILSCALE_LINKS, PHONE_SECTION, TELEGRAM_SECTION, openSettingsSection, pairLink, phoneStatus, takeCodeOnArrival } from './Pairing'
import { Section } from './SettingsParts'
import { PairScreen, codeFromHash, defaultDeviceName } from '@/screens/Pair'
import { api, type PairState } from '@/lib/api'

const phone = { id: 'a', name: 'iPhone', paired_at: 1, last_seen: 1, role: 'viewer' as const }
const tablet = { id: 'b', name: 'iPad', paired_at: 2, last_seen: 2, role: 'viewer' as const }

describe('phoneStatus — the state at a glance', () => {
  it('says Off when nothing listens', () => {
    expect(phoneStatus({ enabled: false, devices: [] }).label).toBe('Off')
    expect(phoneStatus({ enabled: false, devices: [phone] }).label).toBe('Off · 1 phone paired')
  })
  it('says it is waiting while a code is out', () => {
    expect(phoneStatus({ enabled: true, code: '123456', devices: [] })).toEqual({
      tone: 'waiting',
      label: 'Waiting for your phone…',
    })
  })
  it('counts what is connected, and calls a tablet a device', () => {
    expect(phoneStatus({ enabled: true, devices: [phone] }).label).toBe('1 phone connected')
    expect(phoneStatus({ enabled: true, devices: [phone, tablet] }).label).toBe('2 devices connected')
  })
})

describe('the scanned link', () => {
  it('carries the address and the code, and the phone reads the code back', () => {
    const link = pairLink('http://192.168.1.10:22776', '012345')
    expect(link).toBe('http://192.168.1.10:22776/#/pair?code=012345')
    expect(codeFromHash(new URL(link).hash)).toBe('012345')
  })
  it('ignores anything that is not a six-digit code on the pair route', () => {
    expect(codeFromHash('#/pair?code=12345')).toBe('')
    expect(codeFromHash('#/now?code=123456')).toBe('')
    expect(codeFromHash('')).toBe('')
  })
})

describe('Pairing panel', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function stubState(states: PairState[]) {
    let i = 0
    return vi.spyOn(api, 'pairState').mockImplementation(async () => states[Math.min(i++, states.length - 1)]!)
  }

  it('turns network access on and shows a QR code and the digits in one press', async () => {
    stubState([
      { enabled: false, devices: [] },
      { enabled: true, url: 'http://192.168.1.10:22776', code: '482913', expires_in_sec: 300, devices: [] },
    ])
    const setLAN = vi.spyOn(api, 'setLAN').mockResolvedValue({ enabled: true, url: 'http://192.168.1.10:22776' })
    const pairCode = vi.spyOn(api, 'pairCode').mockResolvedValue({ code: '482913', expires_in_sec: 300, url: 'http://192.168.1.10:22776' })

    render(<Pairing />)
    expect(await screen.findByText('Off')).toBeTruthy()
    expect(screen.getByText(/on one network/)).toBeTruthy()
    expect(screen.getByText('Works on this Wi-Fi only')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Show a code' }))
    await waitFor(() => expect(screen.getByRole('img', { name: /QR code/ })).toBeTruthy())
    expect(setLAN).toHaveBeenCalledWith(true)
    expect(pairCode).toHaveBeenCalled()
    expect(screen.getByText('Waiting for your phone…')).toBeTruthy()
    expect(screen.getByLabelText('pairing code 4 8 2 9 1 3')).toBeTruthy()
  })

  it('withdraws the code on the daemon when cancelled', async () => {
    stubState([
      { enabled: true, url: 'http://192.168.1.10:22776', code: '482913', expires_in_sec: 300, devices: [] },
      { enabled: true, url: 'http://192.168.1.10:22776', devices: [] },
    ])
    const cancel = vi.spyOn(api, 'pairCancelCode').mockResolvedValue({ cleared: true })
    render(<Pairing />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(cancel).toHaveBeenCalled())
  })

  it('lists paired devices with a Remove button', async () => {
    stubState([{ enabled: true, url: 'http://192.168.1.10:22776', devices: [phone] }])
    const revoke = vi.spyOn(api, 'pairRevoke').mockResolvedValue({ revoked: 1 })
    render(<Pairing />)
    expect(await screen.findByText('1 phone connected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('a'))
  })

  it('gives a phone control with one button, and takes it away with one', async () => {
    stubState([{ enabled: true, url: 'http://192.168.1.10:22776', devices: [phone, { ...tablet, role: 'controller' }] }])
    const setRole = vi.spyOn(api, 'pairSetRole').mockResolvedValue({ id: 'a', role: 'controller' })
    render(<Pairing />)
    expect(await screen.findByText('view only', { exact: false })).toBeTruthy()
    expect(screen.getByText('can control sessions')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Let it control sessions' }))
    await waitFor(() => expect(setRole).toHaveBeenCalledWith('a', 'controller'))
    fireEvent.click(screen.getByRole('button', { name: 'Take control away' }))
    await waitFor(() => expect(setRole).toHaveBeenCalledWith('b', 'viewer'))
  })

  it('offers the Tailscale address and its MagicDNS name as QR codes beside the Wi-Fi one', async () => {
    localStorage.removeItem('caprock.pair.address')
    stubState([{
      enabled: true, url: 'http://100.101.102.103:22776', tunnelled: true, code: '482913', expires_in_sec: 300, devices: [],
      addresses: [
        { url: 'http://100.101.102.103:22776', kind: 'tailscale' },
        { url: 'http://192.168.1.10:22776', kind: 'lan' },
        { url: 'http://studio-mac.tail1234.ts.net:22776', kind: 'magicdns' },
      ],
    }])
    render(<Pairing />)
    // Tailscale first: a phone paired on the Wi-Fi address works on that
    // Wi-Fi only, since its token is kept per address.
    expect(await screen.findByRole('img', { name: /opens http:\/\/100\.101\.102\.103:22776 / })).toBeTruthy()
    expect(screen.getByText(/even on mobile data\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Wi-Fi' }))
    expect(screen.getByRole('img', { name: /opens http:\/\/192\.168\.1\.10:22776 / })).toBeTruthy()
    expect(screen.getByText(/same Wi-Fi\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Tailscale name' }))
    expect(screen.getByRole('img', { name: /opens http:\/\/studio-mac\.tail1234\.ts\.net:22776 / })).toBeTruthy()
    // Remembered for the next code.
    expect(localStorage.getItem('caprock.pair.address')).toBe('magicdns')
  })

  it('says first, without Tailscale, that it works on this Wi-Fi only and how to get anywhere', async () => {
    stubState([{ enabled: true, url: 'http://192.168.1.10:22776', devices: [], addresses: [{ url: 'http://192.168.1.10:22776', kind: 'lan' }] }])
    render(<Pairing />)
    const reach = await screen.findByTestId('phone-reach')
    expect(reach.textContent).toMatch(/^Works on this Wi-Fi only/)
    expect(reach.textContent).toMatch(/install Tailscale on .* and on the phone, sign in to the same account/)
    const links = [...reach.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(links).toContain(TAILSCALE_LINKS.iphone)
    expect(links).toContain(TAILSCALE_LINKS.android)
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('says it works anywhere once this machine has Tailscale, even with access off', async () => {
    stubState([{ enabled: false, devices: [], tailscale: true }])
    render(<Pairing />)
    expect((await screen.findByTestId('phone-reach')).textContent).toMatch(/^Works anywhere \(Tailscale\)/)
    expect(screen.getByText('Tailscale on both')).toBeTruthy()
  })

  it('asks the daemon to listen on Tailscale once it appears while access is on', async () => {
    const lanOnly = { enabled: true, url: 'http://192.168.1.10:22776', devices: [], tailscale: true, addresses: [{ url: 'http://192.168.1.10:22776', kind: 'lan' as const }] }
    stubState([
      lanOnly,
      { ...lanOnly, addresses: [...lanOnly.addresses, { url: 'http://100.101.102.103:22776', kind: 'tailscale' as const }] },
    ])
    const setLAN = vi.spyOn(api, 'setLAN').mockResolvedValue({ enabled: true, url: 'http://192.168.1.10:22776' })
    render(<Pairing />)
    expect((await screen.findByTestId('phone-reach')).textContent).toMatch(/^Works anywhere \(Tailscale\)/)
    await waitFor(() => expect(setLAN).toHaveBeenCalledWith(true))
    expect(await screen.findByText('http://100.101.102.103:22776')).toBeTruthy()
    expect(setLAN).toHaveBeenCalledTimes(1)
  })

  it('names Tailscale as the requirement when the address is a tunnel', async () => {
    stubState([{ enabled: true, url: 'http://100.101.102.103:22776', tunnelled: true, devices: [] }])
    render(<Pairing />)
    expect(await screen.findByText(/Tailscale on your phone and/)).toBeTruthy()
    expect(screen.queryByText(/Not on this Wi-Fi\?/)).toBeNull()
  })

  it('says beside the code where the phone will work: Wi-Fi only, or anywhere with Tailscale on both', async () => {
    localStorage.removeItem('caprock.pair.address')
    stubState([{ enabled: true, url: 'http://192.168.1.10:22776', code: '482913', expires_in_sec: 300, devices: [], addresses: [{ url: 'http://192.168.1.10:22776', kind: 'lan' }] }])
    render(<Pairing />)
    expect((await screen.findByTestId('pair-reach')).textContent).toMatch(/^Only on this Wi-Fi\. For anywhere.*Tailscale on both your phone/)
    cleanup()
    stubState([{ enabled: true, url: 'http://100.101.102.103:22776', tunnelled: true, code: '482913', expires_in_sec: 300, devices: [], addresses: [{ url: 'http://100.101.102.103:22776', kind: 'tailscale' }] }])
    render(<Pairing />)
    expect((await screen.findByTestId('pair-reach')).textContent).toMatch(/^Anywhere, as long as Tailscale is on, on both your phone/)
  })
})

describe('the name a device offers', () => {
  it('says the kind of device and the browser, so two iPhones differ', () => {
    const iosSafari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    const iosChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1'
    const androidChrome = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
    expect(defaultDeviceName(iosSafari)).toBe('iPhone · Safari')
    expect(defaultDeviceName(iosChrome)).toBe('iPhone · Chrome')
    expect(defaultDeviceName(androidChrome)).toBe('Android phone · Chrome')
    expect(defaultDeviceName('curl/8')).toBe('')
  })

  it('names a home-screen app apart from the browser, since it pairs separately', () => {
    const iosSafari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    expect(defaultDeviceName(iosSafari, true)).toBe('iPhone · home screen')
  })
})

describe('pairing from the home screen', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('asks for the typed code, not a scan, in a home-screen app', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(display-mode: standalone)' }) as MediaQueryList)
    render(<PairScreen />)
    expect(screen.getByText(/keeps its own sign-in/)).toBeTruthy()
    expect(screen.getByText(/the camera opens the browser/)).toBeTruthy()
  })

  it('offers the scan in a browser tab', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }) as MediaQueryList)
    render(<PairScreen />)
    expect(screen.getByText(/Scan it with the camera/)).toBeTruthy()
    expect(screen.queryByText(/keeps its own sign-in/)).toBeNull()
  })
})

describe('Paired devices list', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })
  it('tells two devices with one name apart by id and pairing time', async () => {
    vi.spyOn(api, 'pairState').mockResolvedValue({ enabled: true, url: 'http://192.168.1.10:22776', devices: [
      { ...phone, id: 'ab12cd', paired_at: Date.UTC(2026, 9, 4, 9, 0) },
      { ...phone, id: 'ef34gh', paired_at: Date.UTC(2026, 9, 4, 10, 0) },
    ] })
    render(<Pairing />)
    expect(await screen.findByText('#ab12')).toBeTruthy()
    expect(screen.getByText('#ef34')).toBeTruthy()
    expect(screen.getAllByText(/paired 4 Oct/)).toHaveLength(2)
  })
})

describe('phone access after a restart', () => {
  it('leads with Turn on when phones are paired but access is off', async () => {
    vi.spyOn(api, 'pairState').mockResolvedValue({ enabled: false, devices: [{ id: 'd1', name: 'iPhone', role: 'controller', created_at: 1, last_seen_at: 1 }] } as unknown as PairState)
    const setLAN = vi.spyOn(api, 'setLAN').mockResolvedValue({ enabled: true, url: 'http://192.168.1.10:22776' })
    render(<Pairing />)
    expect(await screen.findByText('Phone access is off')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(setLAN).toHaveBeenCalledWith(true))
  })

  it('offers to keep it on right beside Turn on, and turning it off is a plain off', async () => {
    vi.spyOn(api, 'pairState').mockResolvedValue({ enabled: false, devices: [phone] })
    const setLAN = vi.spyOn(api, 'setLAN').mockResolvedValue({ enabled: true, url: 'http://192.168.1.10:22776', keep_on: true })
    render(<Pairing />)
    fireEvent.click(await screen.findByLabelText('Keep on after Caprock restarts'))
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(setLAN).toHaveBeenCalledWith(true, true))
  })

  it('switches keep-on from the footer while access is on', async () => {
    vi.spyOn(api, 'pairState').mockResolvedValue({ enabled: true, url: 'http://192.168.1.10:22776', devices: [phone], keep_on: true })
    const setLAN = vi.spyOn(api, 'setLAN').mockResolvedValue({ enabled: true, keep_on: false })
    render(<Pairing />)
    const box = (await screen.findByLabelText('Keep on after Caprock restarts')) as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    await waitFor(() => expect(setLAN).toHaveBeenCalledWith(true, false))
  })

  it('says no phone is paired yet when the only device is a computer', async () => {
    vi.spyOn(api, 'pairState').mockResolvedValue({ enabled: false, devices: [{ id: '39e0aa', name: 'Mac', paired_at: 1, last_seen: 1, role: 'viewer' }] })
    render(<Pairing />)
    expect(await screen.findByText('No phone paired yet.')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Show a code' }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Show a code for another phone' })).toBeNull()
  })
})

describe('landing on the phone or Telegram (owner, 2026-10-13)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    location.hash = ''
    localStorage.removeItem('caprock-settings-folds')
  })

  it('opens #/settings/phone, unfolds the section and brings it into view', async () => {
    localStorage.setItem('caprock-settings-folds', JSON.stringify([PHONE_SECTION]))
    const scrolled = vi.fn()
    render(<Section id={PHONE_SECTION} title="Use on your phone"><p>the code</p></Section>)
    expect(screen.queryByText('the code')).toBeNull()
    document.getElementById(PHONE_SECTION)!.scrollIntoView = scrolled
    openSettingsSection('phone')
    expect(location.hash).toBe('#/settings/phone')
    await waitFor(() => expect(scrolled).toHaveBeenCalled())
    expect(await screen.findByText('the code')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('caprock-settings-folds')!)).not.toContain(PHONE_SECTION)
  })

  it('opens #/settings/telegram on the Telegram section', async () => {
    const scrolled = vi.fn()
    render(<Section id={TELEGRAM_SECTION} title="Telegram"><p>bot</p></Section>)
    document.getElementById(TELEGRAM_SECTION)!.scrollIntoView = scrolled
    openSettingsSection('telegram')
    expect(location.hash).toBe('#/settings/telegram')
    await waitFor(() => expect(scrolled).toHaveBeenCalled())
  })

  it('shows a code on arrival only when asked by a click, never by the link alone', async () => {
    openSettingsSection('phone')
    expect(takeCodeOnArrival()).toBe(false)

    vi.spyOn(api, 'pairState').mockResolvedValue({ enabled: false, devices: [] })
    const setLAN = vi.spyOn(api, 'setLAN').mockResolvedValue({ enabled: true, url: 'http://192.168.1.10:22776' })
    const pairCode = vi.spyOn(api, 'pairCode').mockResolvedValue({ code: '482913', expires_in_sec: 300, url: 'http://192.168.1.10:22776' })
    openSettingsSection('phone', { showCode: true })
    render(<Pairing />)
    await waitFor(() => expect(pairCode).toHaveBeenCalledTimes(1))
    expect(setLAN).toHaveBeenCalledWith(true)
    expect(takeCodeOnArrival()).toBe(false)
  })

  it('names the three steps: network, scan, home screen', async () => {
    vi.spyOn(api, 'pairState').mockResolvedValue({ enabled: false, devices: [] })
    render(<Pairing />)
    expect(await screen.findByText('Use on your phone')).toBeTruthy()
    expect(screen.getByText('Scan the code')).toBeTruthy()
    expect(screen.getByText('Add to Home Screen')).toBeTruthy()
  })
})
