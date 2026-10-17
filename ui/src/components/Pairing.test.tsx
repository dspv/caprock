import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { ALLOW_TYPE_KEY, Pairing, isOldDevice, needsRepair, offersOpenAgain, PHONE_SECTION, TELEGRAM_SECTION, openSettingsSection, pairLink, phonePage, phoneSummary, seenAgo, takeCodeOnArrival } from './Pairing'
import { Section } from './SettingsParts'
import { PairScreen, codeFromHash, defaultDeviceName } from '@/screens/Pair'
import { api, type PairState } from '@/lib/api'

const T = Date.now()
const MIN = 60_000
const DAY = 86_400_000
const phone = { id: 'a', name: 'iPhone', paired_at: T - DAY, last_seen: T - 2 * MIN, role: 'viewer' as const }
const tablet = { id: 'b', name: 'iPad', paired_at: T - 2 * DAY, last_seen: T - DAY, role: 'viewer' as const }

describe('phoneSummary — one sentence: is my phone connected?', () => {
  const on = { enabled: true, status: 'online' as const, phones: 0, relay: '', app: '' }
  it('says no phone is connected when there is none, or only old ones and computers', () => {
    expect(phoneSummary({ devices: [] }, T)).toMatchObject({ tone: 'none', text: 'No phone connected yet.' })
    const mac = { ...phone, id: 'm', name: 'Mac', last_seen: T - 44 * DAY, paired_at: T - 45 * DAY }
    const computer = { ...phone, id: 'c', name: 'Mac mini', kind: 'machine' as const }
    expect(phoneSummary({ devices: [mac, computer], remote: on }, T).text).toBe('No phone connected yet.')
  })
  it('names the phone, what it can do and when it was seen', () => {
    const s = phoneSummary({ devices: [{ ...phone, role: 'controller' }, tablet], remote: on }, T)
    expect(s).toMatchObject({ tone: 'ok', text: 'is connected and can control sessions', meta: 'seen 2 min ago · 1 more device' })
    expect(s.device?.name).toBe('iPhone')
    expect(s.fix).toBeUndefined()
  })
  it('a phone not seen for a while is set up, not connected; a viewer gets Allow control', () => {
    const s = phoneSummary({ devices: [tablet], remote: on }, T)
    expect(s).toMatchObject({ tone: 'idle', text: 'is set up and can only view', meta: 'last seen 24 hours ago', fix: 'allow' })
  })
  it('says what is in the way: access from anywhere off, or offline', () => {
    expect(phoneSummary({ devices: [phone], remote: { ...on, enabled: false, status: 'off' } }, T)).toMatchObject({ tone: 'warn', fix: 'turn-on' })
    expect(phoneSummary({ devices: [phone], remote: { ...on, status: 'offline', error: 'no route' } }, T).text).toMatch(/can't get online right now \(no route\)/)
  })
  it('waits while a code is out, and puts the phone that just joined first', () => {
    expect(phoneSummary({ code: '123456', devices: [phone] }, T).text).toBe('Waiting for your phone to scan the code…')
    expect(phoneSummary({ devices: [phone, tablet] }, T, 'b').device?.id).toBe('b')
  })
})

describe('old devices and plain ages', () => {
  it('a device not seen for 30 days is old; one never seen counts from pairing; a waiting computer never is', () => {
    expect(isOldDevice({ last_seen: T - 31 * DAY, paired_at: T - 90 * DAY }, T)).toBe(true)
    expect(isOldDevice({ last_seen: T - 29 * DAY, paired_at: T - 90 * DAY }, T)).toBe(false)
    expect(isOldDevice({ last_seen: 0, paired_at: T - 40 * DAY }, T)).toBe(true)
    expect(isOldDevice({ last_seen: 0, paired_at: T - 40 * DAY, pending: true }, T)).toBe(false)
  })
  it('says ages as a person would', () => {
    expect(seenAgo(T - 10_000, T)).toBe('just now')
    expect(seenAgo(T - 2 * MIN, T)).toBe('2 min ago')
    expect(seenAgo(T - 60 * MIN, T)).toBe('1 hour ago')
    expect(seenAgo(T - 3 * DAY, T)).toBe('3 days ago')
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

function stubState(states: PairState[]) {
  let i = 0
  return vi.spyOn(api, 'pairState').mockImplementation(async () => states[Math.min(i++, states.length - 1)]!)
}

describe('Pairing panel (owner, 2026-10-18: "not one clear piece of info")', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('opens with one sentence and one button, and nothing else in view', async () => {
    stubState([{ enabled: false, devices: [], remote: remoteOn }])
    render(<Pairing />)
    expect((await screen.findByTestId('phone-status')).textContent).toBe('No phone connected yet.')
    expect(screen.getByRole('button', { name: 'Connect a phone' })).toBeTruthy()
    // No checklist, no numbered steps, no QR before the press.
    expect(screen.queryByTestId('pair-checklist')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    // The how is folded away.
    expect((screen.getByTestId('phone-how') as HTMLDetailsElement).open).toBe(false)
  })

  it('Connect a phone turns on access from anywhere, says so first, and shows the QR with one line', async () => {
    stubState([
      { enabled: false, devices: [], remote: remoteOff },
      { enabled: false, code: '482913', expires_in_sec: 300, devices: [], remote: remoteOn },
    ])
    const setRemote = vi.spyOn(api, 'setRemote').mockResolvedValue(remoteOn)
    const setLAN = vi.spyOn(api, 'setLAN')
    const pairCode = vi.spyOn(api, 'pairCode').mockResolvedValue({ code: '482913', expires_in_sec: 300, url: '' })
    render(<Pairing />)
    expect((await screen.findByTestId('anywhere-consent')).textContent).toMatch(/turns on access from anywhere/)
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByText(/Tailscale/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Connect a phone' }))
    await waitFor(() => expect(pairCode).toHaveBeenCalled())
    expect(setRemote).toHaveBeenCalledWith(true)
    expect(setLAN).not.toHaveBeenCalled()
    const qr = await screen.findByTestId('pair-code')
    expect(qr.textContent).toMatch(/^Scan with your phone's camera\. Works once, [45]:\d\d left\.New codeCancel$/)
    expect(within(qr).getByRole('img', { name: /m\.example/ })).toBeTruthy()
    expect(screen.getByTestId('phone-status').textContent).toBe('Waiting for your phone to scan the code…')
    // The home-screen link lives in How it works.
    expect(within(screen.getByTestId('phone-how')).getByRole('button', { name: 'Copy link' })).toBeTruthy()
  })

  it('access from anywhere: on, said inside How it works with its off switch', async () => {
    stubState([{ enabled: false, devices: [phone], remote: remoteOn }])
    const setRemote = vi.spyOn(api, 'setRemote').mockResolvedValue(remoteOff)
    render(<Pairing />)
    const how = await screen.findByTestId('phone-how')
    expect(within(how).getByTestId('relay-state').textContent).toMatch(/Access from anywhere is on/)
    expect(screen.queryByTestId('anywhere-consent')).toBeNull()
    fireEvent.click(within(how).getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(setRemote).toHaveBeenCalledWith(false))
  })

  it('a paired phone with access from anywhere off: the sentence says so, with Turn it on', async () => {
    stubState([{ enabled: false, devices: [phone], remote: remoteOff }])
    const setRemote = vi.spyOn(api, 'setRemote').mockResolvedValue(remoteOn)
    render(<Pairing />)
    const st = await screen.findByTestId('phone-status')
    expect(st.textContent).toMatch(/^iPhone is set up, but access from anywhere is off/)
    fireEvent.click(within(st).getByRole('button', { name: 'Turn it on' }))
    await waitFor(() => expect(setRemote).toHaveBeenCalledWith(true))
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

  it('one row per device: name, one capability word, last seen, Remove', async () => {
    stubState([{ enabled: false, devices: [phone], remote: remoteOn }])
    const revoke = vi.spyOn(api, 'pairRevoke').mockResolvedValue({ revoked: 1 })
    render(<Pairing />)
    const row = await screen.findByTestId('device-row')
    expect(row.textContent).toBe('iPhoneView only · seen 2 min agoAllow controlRemove')
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('a'))
  })

  it('gives a phone control with one button, and takes it away with one', async () => {
    stubState([{ enabled: false, devices: [phone, { ...tablet, role: 'controller' }], remote: remoteOn }])
    const setRole = vi.spyOn(api, 'pairSetRole').mockResolvedValue({ id: 'a', role: 'controller' })
    render(<Pairing />)
    const rows = await screen.findAllByTestId('device-row')
    expect(rows.map((r) => within(r).getByTestId('device-can').textContent)).toEqual(['View only', 'Can control'])
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Allow control' }))
    await waitFor(() => expect(setRole).toHaveBeenCalledWith('a', 'controller'))
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Take control away' }))
    await waitFor(() => expect(setRole).toHaveBeenCalledWith('b', 'viewer'))
  })

  it('a view-only phone that just paired is fixed from the sentence at the top', async () => {
    stubState([{ enabled: false, devices: [phone], remote: remoteOn }])
    const setRole = vi.spyOn(api, 'pairSetRole').mockResolvedValue({ id: 'a', role: 'controller' })
    render(<Pairing />)
    const st = await screen.findByTestId('phone-status')
    expect(st.textContent).toMatch(/^iPhone is connected and can only view · seen 2 min ago/)
    fireEvent.click(within(st).getByRole('button', { name: 'Allow control' }))
    await waitFor(() => expect(setRole).toHaveBeenCalledWith('a', 'controller'))
  })

  it('lists another computer as one, waiting or allowed, with Remove and no role buttons (ADR-067)', async () => {
    const waiting = { ...phone, id: 'm1', name: 'MacBook', role: 'controller' as const, kind: 'machine' as const, pending: true }
    const allowed = { ...tablet, id: 'm2', name: 'Mac mini', role: 'controller' as const, kind: 'machine' as const }
    stubState([{ enabled: false, devices: [waiting, allowed], remote: remoteOn }])
    render(<Pairing />)
    const rows = (await screen.findAllByTestId('device-can')).map((e) => e.textContent)
    expect(rows).toEqual(['Computer · waiting for Allow', 'Computer · controls this one'])
    expect(screen.queryByRole('button', { name: 'Take control away' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Allow control' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2)
  })

  it('folds devices not seen for 30 days, and removes them all after one confirmation', async () => {
    const stale = { ...phone, id: '39e0', name: 'Mac', last_seen: T - 44 * DAY, paired_at: T - 45 * DAY }
    const older = { ...tablet, id: '77aa', last_seen: T - 61 * DAY, paired_at: T - 90 * DAY }
    stubState([{ enabled: false, devices: [phone, stale, older], remote: remoteOn }])
    const revoke = vi.spyOn(api, 'pairRevoke').mockResolvedValue({ revoked: 1 })
    render(<Pairing />)
    const old = await screen.findByTestId('old-devices')
    expect(old.textContent).toMatch(/^›2 old devices · not seen for 30\+ days/)
    expect(screen.getAllByTestId('device-row')).toHaveLength(1)
    fireEvent.click(within(old).getByRole('button', { name: 'Remove all' }))
    // Unfolded to show what goes, and asked once.
    expect(within(old).getAllByTestId('device-row')).toHaveLength(2)
    expect(revoke).not.toHaveBeenCalled()
    fireEvent.click(within(old).getByRole('button', { name: 'Remove 2' }))
    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(2))
    expect(revoke.mock.calls.map((c) => c[0]).sort()).toEqual(['39e0', '77aa'])
  })

  it('Keep withdraws the confirmation and removes nothing', async () => {
    const stale = { ...phone, id: '39e0', name: 'Mac', last_seen: T - 44 * DAY, paired_at: T - 45 * DAY }
    stubState([{ enabled: false, devices: [stale], remote: remoteOn }])
    const revoke = vi.spyOn(api, 'pairRevoke').mockResolvedValue({ revoked: 1 })
    render(<Pairing />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.queryByTestId('old-confirm')).toBeNull()
    expect(revoke).not.toHaveBeenCalled()
    expect(screen.getByTestId('phone-status').textContent).toBe('No phone connected yet.')
  })

  it('marks a phone on the Wi-Fi link with Reconnect, which turns access from anywhere on', async () => {
    const wifiPhone = { ...phone, name: 'Android phone · Chrome', via: 'lan' as const }
    stubState([
      { enabled: true, url: 'http://10.100.102.7:4173', devices: [wifiPhone, { ...tablet, via: 'relay' as const }], remote: remoteOff },
      { enabled: true, url: 'http://10.100.102.7:4173', code: '482913', expires_in_sec: 300, devices: [wifiPhone], remote: remoteOn },
    ])
    const setRemote = vi.spyOn(api, 'setRemote').mockResolvedValue(remoteOn)
    const pairCode = vi.spyOn(api, 'pairCode').mockResolvedValue({ code: '482913', expires_in_sec: 300, url: '' })
    render(<Pairing />)
    expect((await screen.findAllByTestId('device-repair')).map((e) => e.textContent)).toEqual(['Works on your home Wi-Fi only.Reconnect'])
    // The Wi-Fi listener that is on is said, with its off switch.
    expect(screen.getByTestId('wifi-listener').textContent).toMatch(/works only on the same network/)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(pairCode).toHaveBeenCalled())
    expect(setRemote).toHaveBeenCalledWith(true)
    expect(await screen.findByTestId('pair-code')).toBeTruthy()
  })

  it('stops asking a Wi-Fi phone to reconnect once its twin comes through the relay, and tells the twins apart by id', async () => {
    const lanTwin = { ...phone, id: 'old1', via: 'lan' as const }
    const relayTwin = { ...phone, id: 'new1', via: 'relay' as const }
    stubState([{ enabled: false, devices: [lanTwin, relayTwin], remote: remoteOn }])
    render(<Pairing />)
    expect(await screen.findByText('#old1')).toBeTruthy()
    expect(screen.getByText('#new1')).toBeTruthy()
    expect(screen.queryByTestId('device-repair')).toBeNull()
  })

  it('falls back to the network listener in a build without the relay', async () => {
    stubState([
      { enabled: false, devices: [] },
      { enabled: true, url: 'http://192.168.1.10:22776', code: '482913', expires_in_sec: 300, devices: [] },
    ])
    const setLAN = vi.spyOn(api, 'setLAN').mockResolvedValue({ enabled: true, url: 'http://192.168.1.10:22776' })
    vi.spyOn(api, 'pairCode').mockResolvedValue({ code: '482913', expires_in_sec: 300, url: 'http://192.168.1.10:22776' })
    render(<Pairing />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a phone' }))
    await waitFor(() => expect(screen.getByRole('img', { name: /QR code/ })).toBeTruthy())
    expect(setLAN).toHaveBeenCalledWith(true)
    expect(screen.getByLabelText('pairing code 4 8 2 9 1 3')).toBeTruthy()
    expect(screen.getByTestId('pair-reach').textContent).toMatch(/^Only on this Wi-Fi: the phone has to be on the same network/)
  })
})

// The owner, 2026-10-14 (translated): "I scan it with the phone, install the
// app, go in — and I can't do anything, and say I've already left the house."
describe('control is chosen with the code', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('is ticked by default, and the code it shows pairs a controller', async () => {
    vi.spyOn(api, 'pairState').mockResolvedValue({ enabled: false, devices: [], remote: remoteOn })
    const pairCode = vi.spyOn(api, 'pairCode').mockResolvedValue({ code: '482913', role: 'controller', expires_in_sec: 300, url: '' })
    render(<Pairing />)
    const box = (await screen.findByTestId('allow-type')) as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Connect a phone' }))
    await waitFor(() => expect(pairCode).toHaveBeenCalledWith('controller'))
  })

  it('unticked, pairs to view only, and remembers that on this computer', async () => {
    vi.spyOn(api, 'pairState').mockResolvedValue({ enabled: false, devices: [], remote: remoteOn })
    const pairCode = vi.spyOn(api, 'pairCode').mockResolvedValue({ code: '482913', role: 'viewer', expires_in_sec: 300, url: '' })
    render(<Pairing />)
    fireEvent.click(await screen.findByTestId('allow-type'))
    expect(screen.getByText(/View only: it can read, not type/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect a phone' }))
    await waitFor(() => expect(pairCode).toHaveBeenCalledWith('viewer'))
    expect(localStorage.getItem(ALLOW_TYPE_KEY)).toBe('0')
    cleanup()
    render(<Pairing />)
    expect(((await screen.findByTestId('allow-type')) as HTMLInputElement).checked).toBe(false)
  })

  it('the sentence turns from waiting to the phone that joined, as it pairs', async () => {
    const joined = { id: 'p1', name: 'Android phone · Chrome', paired_at: Date.now(), last_seen: Date.now(), role: 'controller' as const }
    const states: PairState[] = [
      { enabled: false, devices: [tablet], remote: remoteOn },
      { enabled: false, code: '482913', code_role: 'controller', expires_in_sec: 300, devices: [tablet], remote: remoteOn },
      { enabled: false, devices: [tablet, joined], remote: remoteOn },
    ]
    let i = 0
    vi.spyOn(api, 'pairState').mockImplementation(async () => states[Math.min(i, states.length - 1)]!)
    vi.spyOn(api, 'pairCode').mockImplementation(async () => {
      i = 1
      return { code: '482913', role: 'controller', expires_in_sec: 300, url: '' }
    })
    render(<Pairing />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect another phone' }))
    await waitFor(() => expect(screen.getByTestId('phone-status').dataset.tone).toBe('waiting'))
    i = 2
    await waitFor(() => expect(screen.getByTestId('phone-status').textContent).toMatch(/^Android phone · Chrome is connected and can control sessions · seen just now/), { timeout: 4000 })
  }, 10000)
})

// Vova, 2026-10-15 (translated): "yesterday I opened the phone app, then
// closed the tab; in Caprock the device shows as paired; today I want to
// open the app again but I don't remember the link — and that's it".
describe('a paired phone finds its way back', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('the address, as typed and as the QR opens it, carries nothing after the page', () => {
    expect(phonePage('https://m.caprock.dev')).toEqual({ host: 'm.caprock.dev', url: 'https://m.caprock.dev/' })
    expect(phonePage('https://m.caprock.dev/')).toEqual({ host: 'm.caprock.dev', url: 'https://m.caprock.dev/' })
    expect(phonePage('https://example.org/caprock/')).toEqual({ host: 'example.org/caprock', url: 'https://example.org/caprock/' })
  })

  it('is offered for a phone through the relay, not for a Wi-Fi link or the machine itself', () => {
    expect(offersOpenAgain({ name: 'iPhone', via: 'relay' })).toBe(true)
    expect(offersOpenAgain({ name: 'iPhone' })).toBe(true)
    expect(offersOpenAgain({ name: 'iPhone', via: 'lan' })).toBe(false)
    expect(offersOpenAgain({ name: 'This computer · Safari' })).toBe(false)
  })

  it('How it works says to just open the address, and shows a QR of the address alone', async () => {
    vi.spyOn(api, 'pairState').mockResolvedValue({ enabled: false, devices: [{ ...phone, via: 'relay' }], remote: { ...remoteOn, app: 'https://m.caprock.dev' } })
    render(<Pairing />)
    const how = await screen.findByTestId('phone-how')
    expect(how.textContent).toContain('Closed the page on a phone you already connected? Just open m.caprock.dev on it again.')
    fireEvent.click(within(how).getByRole('button', { name: 'Show the address as a code' }))
    const block = screen.getByTestId('open-again')
    const qr = block.querySelector('svg')!
    expect(qr.getAttribute('data-qr-text')).toBe('https://m.caprock.dev/')
    expect(qr.getAttribute('aria-label')).toBe('QR code that opens m.caprock.dev')
    expect(block.textContent).toContain('Share → Add to Home Screen')
    expect(screen.queryByTestId('send-link')).toBeNull()
    expect(screen.queryByTestId('open-again-off')).toBeNull()
  })

  it('sends the link to Telegram when a bot is set up, saying what it sends', async () => {
    vi.spyOn(api, 'pairState').mockResolvedValue({ enabled: false, telegram: true, devices: [{ ...phone, via: 'relay' }], remote: { ...remoteOn, app: 'https://m.caprock.dev' } })
    const send = vi.spyOn(api, 'pairSendLink').mockResolvedValue({ sent: 'telegram', link: 'https://m.caprock.dev' })
    render(<Pairing />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show the address as a code' }))
    expect(screen.getByTestId('open-again').textContent).toContain('no code and no key')
    fireEvent.click(screen.getByTestId('send-link'))
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(await screen.findByText('Sent to Telegram ✓')).toBeTruthy()
  })

  it('is not offered when the only phone is on a Wi-Fi link, which has its own way to move', async () => {
    vi.spyOn(api, 'pairState').mockResolvedValue({ enabled: false, devices: [{ ...phone, via: 'lan' }], remote: remoteOn })
    render(<Pairing />)
    expect(await screen.findByTestId('device-repair')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show the address as a code' })).toBeNull()
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

})
