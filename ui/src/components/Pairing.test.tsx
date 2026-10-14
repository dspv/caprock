import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { Pairing, needsRepair, PHONE_SECTION, TELEGRAM_SECTION, openSettingsSection, pairLink, phoneStatus, takeCodeOnArrival } from './Pairing'
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
  it('is on while access from anywhere is, with the network listener off', () => {
    const remote = { enabled: true, status: 'online' as const, phones: 0, relay: '', app: '' }
    expect(phoneStatus({ enabled: false, devices: [phone], remote }).label).toBe('1 phone connected')
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

const remoteOff = { enabled: false, status: 'off' as const, phones: 0, relay: 'wss://relay.example', app: 'https://m.example', host_id: 'h' }
const remoteOn = {
  ...remoteOff,
  enabled: true,
  status: 'online' as const,
  link: 'https://m.example/#/pair?c=482913&h=h&k=k&r=wss%3A%2F%2Frelay.example',
}

describe('Pairing panel: one way in, from anywhere (owner, 2026-10-14)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function stubState(states: PairState[]) {
    let i = 0
    return vi.spyOn(api, 'pairState').mockImplementation(async () => states[Math.min(i++, states.length - 1)]!)
  }

  it('says that Show a code turns on access from anywhere, and does it in the same press', async () => {
    stubState([
      { enabled: false, devices: [], remote: remoteOff },
      { enabled: false, code: '482913', expires_in_sec: 300, devices: [], remote: remoteOn },
    ])
    const setRemote = vi.spyOn(api, 'setRemote').mockResolvedValue(remoteOn)
    const setLAN = vi.spyOn(api, 'setLAN')
    const pairCode = vi.spyOn(api, 'pairCode').mockResolvedValue({ code: '482913', expires_in_sec: 300, url: '' })
    render(<Pairing />)
    expect((await screen.findByTestId('anywhere-consent')).textContent).toMatch(/Showing a code turns on access from anywhere/)
    // No choice of networks, no Wi-Fi switch, no Tailscale.
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByText(/Tailscale/)).toBeNull()
    expect(screen.queryByText('Keep on after Caprock restarts')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show a code' }))
    await waitFor(() => expect(pairCode).toHaveBeenCalled())
    expect(setRemote).toHaveBeenCalledWith(true)
    expect(setLAN).not.toHaveBeenCalled()
    expect((await screen.findByTestId('pair-reach')).textContent).toMatch(/^Anywhere — Wi-Fi or mobile data/)
    expect(screen.getByRole('img', { name: /m\.example/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy()
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('with access from anywhere on, says it is online and offers to turn it off', async () => {
    stubState([{ enabled: false, devices: [phone], remote: remoteOn }])
    const setRemote = vi.spyOn(api, 'setRemote').mockResolvedValue(remoteOff)
    render(<Pairing />)
    expect(await screen.findByText('Anywhere · online')).toBeTruthy()
    expect(screen.queryByTestId('anywhere-consent')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(setRemote).toHaveBeenCalledWith(false))
  })

  it('withdraws the code on the daemon when cancelled', async () => {
    stubState([
      { enabled: false, code: '482913', expires_in_sec: 300, devices: [], remote: remoteOn },
      { enabled: false, devices: [], remote: remoteOn },
    ])
    const cancel = vi.spyOn(api, 'pairCancelCode').mockResolvedValue({ cleared: true })
    render(<Pairing />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(cancel).toHaveBeenCalled())
  })

  it('lists paired devices with a Remove button', async () => {
    stubState([{ enabled: false, devices: [phone], remote: remoteOn }])
    const revoke = vi.spyOn(api, 'pairRevoke').mockResolvedValue({ revoked: 1 })
    render(<Pairing />)
    expect(await screen.findByText('1 phone connected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('a'))
  })

  it('gives a phone control with one button, and takes it away with one', async () => {
    stubState([{ enabled: false, devices: [phone, { ...tablet, role: 'controller' }], remote: remoteOn }])
    const setRole = vi.spyOn(api, 'pairSetRole').mockResolvedValue({ id: 'a', role: 'controller' })
    render(<Pairing />)
    expect(await screen.findByText('view only', { exact: false })).toBeTruthy()
    expect(screen.getByText('can control sessions')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Let it control sessions' }))
    await waitFor(() => expect(setRole).toHaveBeenCalledWith('a', 'controller'))
    fireEvent.click(screen.getByRole('button', { name: 'Take control away' }))
    await waitFor(() => expect(setRole).toHaveBeenCalledWith('b', 'viewer'))
  })

  it('marks a phone on the Wi-Fi link and shows the code that moves it, which turns access from anywhere on', async () => {
    const wifiPhone = { ...phone, name: 'Android phone · Chrome', via: 'lan' as const }
    stubState([
      { enabled: true, url: 'http://10.100.102.7:4173', devices: [wifiPhone, { ...tablet, via: 'relay' as const }], remote: remoteOff },
      { enabled: true, url: 'http://10.100.102.7:4173', code: '482913', expires_in_sec: 300, devices: [wifiPhone], remote: remoteOn },
    ])
    const setRemote = vi.spyOn(api, 'setRemote').mockResolvedValue(remoteOn)
    const pairCode = vi.spyOn(api, 'pairCode').mockResolvedValue({ code: '482913', expires_in_sec: 300, url: '' })
    render(<Pairing />)
    const vias = (await screen.findAllByTestId('device-via')).map((e) => e.textContent)
    expect(vias).toEqual(['Wi-Fi link', 'anywhere'])
    const repair = screen.getByTestId('device-repair')
    expect(repair.textContent).toMatch(/Works on this Wi-Fi only\. Pair it once more to use it anywhere/)
    expect(screen.getAllByTestId('device-repair')).toHaveLength(1)
    // The Wi-Fi listener that is on is said, with its off switch.
    expect(screen.getByTestId('wifi-listener').textContent).toMatch(/works only on the same network/)
    fireEvent.click(screen.getByRole('button', { name: 'Show the code' }))
    await waitFor(() => expect(pairCode).toHaveBeenCalled())
    expect(setRemote).toHaveBeenCalledWith(true)
    expect(await screen.findByRole('button', { name: 'Copy link' })).toBeTruthy()
  })

  it('stops asking a Wi-Fi phone to re-pair once its twin comes through the relay', async () => {
    const lanTwin = { ...phone, id: 'old', via: 'lan' as const }
    const relayTwin = { ...phone, id: 'new', paired_at: 5, via: 'relay' as const }
    stubState([{ enabled: false, devices: [lanTwin, relayTwin], remote: remoteOn }])
    render(<Pairing />)
    expect((await screen.findAllByTestId('device-via')).map((e) => e.textContent)).toEqual(['Wi-Fi link', 'anywhere'])
    expect(screen.queryByTestId('device-repair')).toBeNull()
  })

  it('says nothing about the route of a device not seen since it was recorded', async () => {
    stubState([{ enabled: false, devices: [phone], remote: remoteOn }])
    render(<Pairing />)
    expect(await screen.findByText('1 phone connected')).toBeTruthy()
    expect(screen.queryByTestId('device-via')).toBeNull()
  })

  it('falls back to the network listener in a build without the relay', async () => {
    stubState([
      { enabled: false, devices: [] },
      { enabled: true, url: 'http://192.168.1.10:22776', code: '482913', expires_in_sec: 300, devices: [] },
    ])
    const setLAN = vi.spyOn(api, 'setLAN').mockResolvedValue({ enabled: true, url: 'http://192.168.1.10:22776' })
    vi.spyOn(api, 'pairCode').mockResolvedValue({ code: '482913', expires_in_sec: 300, url: 'http://192.168.1.10:22776' })
    render(<Pairing />)
    expect(await screen.findByText('Off')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show a code' }))
    await waitFor(() => expect(screen.getByRole('img', { name: /QR code/ })).toBeTruthy())
    expect(setLAN).toHaveBeenCalledWith(true)
    expect(screen.getByLabelText('pairing code 4 8 2 9 1 3')).toBeTruthy()
    expect(screen.getByTestId('pair-reach').textContent).toMatch(/^Only on this Wi-Fi: the phone has to be on the same network/)
  })
})

describe('needsRepair', () => {
  it('is a Wi-Fi link with no twin through the relay', () => {
    const a = { ...phone, via: 'lan' as const }
    expect(needsRepair(a, [a])).toBe(true)
    expect(needsRepair({ ...phone, via: 'relay' }, [a])).toBe(false)
    expect(needsRepair({ ...phone, via: 'tailscale' }, [a])).toBe(false)
    expect(needsRepair(phone, [phone])).toBe(false)
    expect(needsRepair(a, [a, { ...phone, id: 'z', via: 'relay' }])).toBe(false)
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

describe('a computer in the list', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
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

    vi.spyOn(api, 'pairState').mockResolvedValue({ enabled: false, devices: [], remote: remoteOn })
    const pairCode = vi.spyOn(api, 'pairCode').mockResolvedValue({ code: '482913', expires_in_sec: 300, url: '' })
    openSettingsSection('phone', { showCode: true })
    render(<Pairing />)
    await waitFor(() => expect(pairCode).toHaveBeenCalledTimes(1))
    expect(takeCodeOnArrival()).toBe(false)
  })

  it('never turns access from anywhere on by arriving: that is the button', async () => {
    vi.spyOn(api, 'pairState').mockResolvedValue({ enabled: false, devices: [], remote: remoteOff })
    const setRemote = vi.spyOn(api, 'setRemote')
    const pairCode = vi.spyOn(api, 'pairCode')
    openSettingsSection('phone', { showCode: true })
    render(<Pairing />)
    expect(await screen.findByTestId('anywhere-consent')).toBeTruthy()
    expect(setRemote).not.toHaveBeenCalled()
    expect(pairCode).not.toHaveBeenCalled()
  })

  it('names the three steps: show, scan, home screen', async () => {
    vi.spyOn(api, 'pairState').mockResolvedValue({ enabled: false, devices: [] })
    render(<Pairing />)
    expect(await screen.findByText('Use on your phone')).toBeTruthy()
    expect(screen.getByText('Scan the code')).toBeTruthy()
    expect(screen.getByText('Add to Home Screen')).toBeTruthy()
  })
})
