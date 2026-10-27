import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The plugins' native halves do not exist under jsdom; nothing here may reach them.
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  KeychainAccess: { whenUnlockedThisDeviceOnly: 1 },
  SecureStorage: { setKeyPrefix: vi.fn(), setSynchronize: vi.fn(), setDefaultKeychainAccess: vi.fn(), get: vi.fn(async () => null), set: vi.fn(), remove: vi.fn() },
}))
vi.mock('@aparajita/capacitor-biometric-auth', () => ({ BiometryType: { faceId: 2, touchId: 1 }, BiometricAuth: { checkBiometry: vi.fn(), authenticate: vi.fn() } }))

import { isNativeApp, sellsHere } from './platform'
import { NOT_A_LINK, pairHash } from './pairing'
import { startPhase, Welcome } from './NativeRoot'
import { roleWords } from './Settings'
import { scanFailure } from './scan'
import { errorCode } from './speech'
import { speechHint, speechSupport, speechWhere } from '@/lib/speech'
import { PremiumModal } from '@/components/PremiumModal'
import { PhoneBar } from '@/components/PhoneBar'
import { resetNudgeSlots, useNudgeSlot } from '@/lib/nudges'

const KEY = 'A'.repeat(43)
const LINK = `https://m.caprock.dev/#/pair?r=wss%3A%2F%2Frelay.caprock.dev&h=${KEY}&k=${KEY}&c=123456&n=Studio`

function native(on: boolean) {
  const w = window as unknown as { Capacitor?: unknown }
  if (on) w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }
  else delete w.Capacitor
}

afterEach(() => native(false))

describe('the iOS app check', () => {
  it('is false on the web page and the desktop, true inside the app', () => {
    expect(isNativeApp()).toBe(false)
    expect(sellsHere()).toBe(true)
    native(true)
    expect(isNativeApp()).toBe(true)
    expect(sellsHere()).toBe(false)
  })
})

describe('pairing links', () => {
  it('keeps the #/pair part of a scanned or pasted link, and refuses anything else', () => {
    expect(pairHash(` ${LINK} `)).toBe(LINK.slice(LINK.indexOf('#')))
    expect(pairHash('https://example.com/#/pair?r=wss://x&h=short&k=short')).toBe('')
    expect(pairHash('hello')).toBe('')
  })

  it('starts on the page for a link, the demo when asked, else welcome or the page', () => {
    expect(startPhase({ demo: false, machines: 0, pairLink: true })).toBe('remote')
    expect(startPhase({ demo: true, machines: 2, pairLink: false })).toBe('demo')
    expect(startPhase({ demo: false, machines: 0, pairLink: false })).toBe('welcome')
    expect(startPhase({ demo: false, machines: 1, pairLink: false })).toBe('remote')
  })

  it('tells a closed scanner from a refused camera', () => {
    expect(scanFailure({ code: 'OS-PLUG-BARC-0006' })).toEqual({ cancelled: true })
    expect('error' in scanFailure({ code: 'OS-PLUG-BARC-0007' })).toBe(true)
  })
})

describe('the first-launch screen', () => {
  it('offers pairing, the demo and a pasted link, and says a bad paste is not a link', () => {
    render(<Welcome />)
    expect(screen.getByText('Your coding agents, on your phone')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Pair with your Mac/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try it without a Mac' })).toBeTruthy()
    expect(screen.getByText(/connects to nothing/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Paste a link instead' }))
    fireEvent.change(screen.getByPlaceholderText('Paste the link'), { target: { value: 'not a link' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    expect(screen.getByRole('alert').textContent).toBe(NOT_A_LINK)
  })
})

describe('settings words', () => {
  it('says what the role lets this phone do', () => {
    expect(roleWords('controller')).toBe('type, start, approve')
    expect(roleWords('viewer')).toBe('read only')
    expect(roleWords(undefined)).toBe('—')
  })
})

describe('voice in the app', () => {
  it('is offered without the Web Speech API, and says the words stay on the iPhone', () => {
    expect(speechWhere()).toBe("Your browser's speech service turns it into text.")
    native(true)
    expect(speechSupport()).toBe('ok')
    expect(speechWhere()).toMatch(/on this iPhone/)
    expect(speechHint('on-device-unavailable')).toMatch(/cannot recognise that language on its own/)
  })

  it('reads the plugin\'s failures as the codes the hints know', () => {
    expect(errorCode('Missing speech recognition permission.')).toBe('not-allowed')
    expect(errorCode('ON_DEVICE_RECOGNITION_UNAVAILABLE')).toBe('on-device-unavailable')
    expect(errorCode('KAFASSISTANTERRORDOMAIN_1110 No speech detected')).toBe('aborted-native')
  })
})

describe('nothing for sale in the app', () => {
  beforeEach(() => resetNudgeSlots())

  it('the Premium dialog names the feature with no price and no link', () => {
    native(true)
    render(<PremiumModal feature="cap" onClose={() => {}} />)
    const box = screen.getByTestId('not-sold-here')
    expect(box.textContent).not.toMatch(/\$/)
    expect(box.querySelector('a')).toBeNull()
  })

  it('the phone bar has the app settings and no Get premium', () => {
    native(true)
    const link = { phase: 'live', attempt: 0, nextAt: 0, offlineSince: 0 } as unknown as Parameters<typeof PhoneBar>[0]['link']
    render(<PhoneBar link={link} heardAt={() => Date.now()} />)
    expect(screen.getByRole('link', { name: 'App settings' }).getAttribute('href')).toBe('#/app-settings')
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.queryByRole('menuitem', { name: /Get premium/ })).toBeNull()
  })

  it('a selling offer never wins the slot; others still do', () => {
    native(true)
    function Offer({ id }: { id: 'premium-hint' | 'star' }) {
      return useNudgeSlot(id, true) ? <p>{id}</p> : null
    }
    const { unmount } = render(<Offer id="premium-hint" />)
    expect(screen.queryByText('premium-hint')).toBeNull()
    unmount()
    render(<Offer id="star" />)
    expect(screen.getByText('star')).toBeTruthy()
  })
})
