/**
 * Installing the phone's page once, on purpose (owner, 2026-10-14,
 * translated: "I opened it again and Caprock started downloading again —
 * very strange. Maybe m.caprock.dev should have an install button?").
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { INSTALLED_KEY, installOffer, listenForInstall, promptInstall } from './install'

const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const base = { standalone: false, prompt: false, installed: false, ua: ANDROID, touchPoints: 5 }

describe('what the page offers', () => {
  it('a button only when Chrome says the app can be installed', () => {
    expect(installOffer({ ...base, prompt: true })).toBe('button')
    // No go-ahead from Chrome (already installed, or not installable): no
    // menu steps that could add a second icon.
    expect(installOffer(base)).toBeNull()
  })
  it('nothing inside the app itself', () => {
    expect(installOffer({ ...base, standalone: true, prompt: true })).toBeNull()
  })
  it('"on your home screen" in a browser tab of a phone where the app ran', () => {
    expect(installOffer({ ...base, installed: true })).toBe('installed')
  })
  it('the steps on an iPhone, where Safari has no install event', () => {
    expect(installOffer({ ...base, ua: IPHONE })).toBe('ios')
  })
})

describe('Chrome\'s prompt is the page\'s to show', () => {
  it('holds the automatic prompt back, keeps it for the button, and remembers an install', async () => {
    localStorage.setItem(INSTALLED_KEY, '1')
    listenForInstall(window)
    const prompt = vi.fn(async () => {})
    const e = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    // Chrome offers only while not installed: a remembered install is stale.
    expect(localStorage.getItem(INSTALLED_KEY)).toBeNull()
    expect(await promptInstall()).toBe(true)
    expect(prompt).toHaveBeenCalledOnce()
    expect(localStorage.getItem(INSTALLED_KEY)).toBe('1')
    // A prompt is good once.
    expect(await promptInstall()).toBe(false)
  })
})

describe('the manifest', () => {
  it('keeps the id a new build must share, so a redeploy is the same app and never a second one', () => {
    const m = JSON.parse(readFileSync(resolve(__dirname, '../../public/manifest.json'), 'utf8')) as Record<string, unknown>
    expect(m.id).toBe('/')
    expect(m.start_url).toBe('/#/')
    expect(m.scope).toBe('/')
    expect(m.display).toBe('standalone')
  })
})
