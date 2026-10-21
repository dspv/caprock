/**
 * Phone mode's numbers (ADR-075, amended 2026-10-21): the page area each
 * device leaves, what is an estimate, how the frame fits, and the
 * preferences.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ANDROID_CHROME_UA, DEFAULT_PHONE_PREFS, DEVICES, IOS_SAFARI_UA, PHONE_PREFS_KEY, TRUTH, customDevice, deviceOf, fitOf, frameSize, hostOs, layoutOf, loadPhonePrefs, phoneOn, phoneSpec, savePhonePrefs, setPhoneOn } from './phonemode'

const dev = (id: string) => DEVICES.find((d) => d.id === id)!

afterEach(() => localStorage.clear())

describe('the devices', () => {
  it('are the four asked for, with their published screens', () => {
    expect(DEVICES.map((d) => [d.id, d.w, d.h, d.dpr])).toEqual([
      ['iphone16', 393, 852, 3],
      ['iphonese', 375, 667, 2],
      ['pixel9', 412, 923, 2.625],
      ['s24', 360, 780, 3],
    ])
  })

  it('send their browser’s user agent: Safari on iOS, Chrome on Android', () => {
    expect(dev('iphone16').ua).toBe(IOS_SAFARI_UA)
    expect(dev('iphonese').ua).toBe(IOS_SAFARI_UA)
    expect(dev('pixel9').ua).toBe(ANDROID_CHROME_UA)
    expect(dev('s24').ua).toBe(ANDROID_CHROME_UA)
    // The shell's touch script starts on for a phone's agent (browser.rs TOUCH_SCRIPT).
    for (const d of DEVICES) expect(/\bMobile\b/.test(d.ua)).toBe(true)
    expect(phoneSpec(dev('pixel9'), false)).toEqual({ ua: ANDROID_CHROME_UA, touch: false })
  })
})

describe('the page area', () => {
  it('is the screen less the bars, portrait, and says it is an estimate', () => {
    const p = (id: string, bars: 'shown' | 'hidden') => { const l = layoutOf(dev(id), bars, false); return [l.pageW, l.pageH, l.est] }
    expect(p('iphone16', 'shown')).toEqual([393, 852 - 54 - 83 - 34, true])
    expect(p('iphone16', 'hidden')).toEqual([393, 852 - 54 - 32 - 34, true])
    expect(p('iphonese', 'shown')).toEqual([375, 667 - 20 - 94, true])
    expect(p('pixel9', 'shown')).toEqual([412, 923 - 40 - 56 - 24, true])
    expect(p('pixel9', 'hidden')).toEqual([412, 923 - 40 - 24, true])
    expect(p('s24', 'shown')).toEqual([360, 780 - 36 - 56 - 24, true])
  })

  it('adds up: the bands fill the screen exactly', () => {
    for (const d of DEVICES) {
      for (const bars of ['shown', 'hidden'] as const) {
        for (const rot of [false, true]) {
          const l = layoutOf(d, bars, rot)
          expect(l.bands.reduce((s, b) => s + b.h, 0), `${d.id} ${bars} ${rot}`).toBe(l.screenH)
          expect(l.bands.filter((b) => b.kind === 'page')).toHaveLength(1)
          expect(l.pageW).toBeLessThanOrEqual(l.screenW)
        }
      }
    }
  })

  it('swaps sides on rotate, keeping clear of the island', () => {
    const l = layoutOf(dev('iphone16'), 'shown', true)
    expect([l.screenW, l.screenH]).toEqual([852, 393])
    expect(l.pageW).toBe(852 - 2 * 59)
    expect(l.bands.some((b) => b.kind === 'status')).toBe(false)
    const a = layoutOf(dev('pixel9'), 'hidden', true)
    expect([a.pageW, a.pageH]).toEqual([923, 412 - 16])
  })

  it('is exactly W×H for a custom size, no estimate, kept in bounds', () => {
    const l = layoutOf(customDevice(390, 700), 'shown', false)
    expect([l.pageW, l.pageH, l.est]).toEqual([390, 700, false])
    expect(layoutOf(customDevice(390, 700), 'shown', true).pageW).toBe(700)
    expect(customDevice(5, 99999).w).toBe(200)
    expect(customDevice(5, 99999).h).toBe(2000)
    expect(customDevice(Number.NaN, 400).w).toBe(390)
  })
})

describe('the fit', () => {
  it('draws the whole phone when it fits, the page area alone when only that fits, and never scales it', () => {
    const d = dev('iphone16')
    const l = layoutOf(d, 'shown', false)
    const frame = frameSize(d, l, false)
    expect(frame).toEqual({ w: 393 + 22, h: 852 + 22 })
    const page = { w: l.pageW, h: l.pageH }
    expect(fitOf(frame, page, { w: 1200, h: 1000 })).toBe('full')
    // A laptop's tab: about 790 logical px tall.
    expect(fitOf(frame, page, { w: 1200, h: 790 })).toBe('page')
    expect(fitOf(frame, page, { w: 1200, h: 600 })).toBe('over')
    // The SE's chin and forehead count.
    const se = dev('iphonese')
    expect(frameSize(se, layoutOf(se, 'shown', false), false).h).toBe(667 + 62 + 74)
  })
})

describe('the preferences', () => {
  it('default to an iPhone 16, bars shown, touch on, and survive a reload', () => {
    expect(loadPhonePrefs()).toEqual(DEFAULT_PHONE_PREFS)
    savePhonePrefs({ ...DEFAULT_PHONE_PREFS, device: 'pixel9', rotate: true, bars: 'hidden', touch: false })
    expect(loadPhonePrefs()).toMatchObject({ device: 'pixel9', rotate: true, bars: 'hidden', touch: false })
    expect(deviceOf(loadPhonePrefs()).name).toBe('Pixel 9')
  })

  it('read anything odd as the default', () => {
    localStorage.setItem(PHONE_PREFS_KEY, '{"device":"nokia","bars":7,"customW":"x"}')
    expect(loadPhonePrefs()).toMatchObject({ device: 'iphone16', bars: 'shown', touch: true, customW: 390 })
    localStorage.setItem(PHONE_PREFS_KEY, 'not json')
    expect(loadPhonePrefs()).toEqual(DEFAULT_PHONE_PREFS)
  })

  it('keep phone mode per tab', () => {
    expect(phoneOn('page:a')).toBe(false)
    setPhoneOn('page:a', true)
    expect(phoneOn('page:a')).toBe(true)
    expect(phoneOn('page:b')).toBe(false)
    setPhoneOn('page:a', false)
    expect(phoneOn('page:a')).toBe(false)
  })
})

describe('the honest list', () => {
  it('has each OS’s real, approximate and missing parts, touch never called real', () => {
    for (const os of ['mac', 'win', 'lin'] as const) {
      const kinds = new Set(TRUTH[os].map(([k]) => k))
      expect(kinds).toEqual(new Set(['real', 'approx', 'no']))
      expect(TRUTH[os].find(([, lead]) => lead === 'Touch')?.[0]).toBe('approx')
      expect(TRUTH[os].some(([k, lead]) => k === 'no' && /devicePixelRatio/.test(lead))).toBe(true)
    }
    expect(hostOs('MacIntel')).toBe('mac')
    expect(hostOs('Win32')).toBe('win')
    expect(hostOs('Linux x86_64')).toBe('lin')
  })
})
