import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The plugin's native half does not exist under jsdom: a fake that replays
// the events Apple's recogniser sends through it.
const plugin = vi.hoisted(() => ({
  listeners: {} as Record<string, (e: Record<string, unknown>) => void>,
  starts: 0,
}))
vi.mock('@capgo/capacitor-speech-recognition', () => ({
  SpeechRecognition: {
    checkPermissions: vi.fn(async () => ({ speechRecognition: 'granted' })),
    requestPermissions: vi.fn(async () => ({ speechRecognition: 'granted' })),
    isOnDeviceRecognitionAvailable: vi.fn(async () => ({ available: true })),
    addListener: vi.fn(async (name: string, fn: (e: Record<string, unknown>) => void) => {
      plugin.listeners[name] = fn
      return { remove: async () => {} }
    }),
    start: vi.fn(async () => { plugin.starts++ }),
    stop: vi.fn(async () => { plugin.listeners.listeningState?.({ state: 'stopped' }) }),
  },
}))

import { startNativeDictation } from './speech'

/** Lets the async setup (permissions, listeners, start) run. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function partial(text: string, afterMs = 150) {
  vi.advanceTimersByTime(afterMs)
  plugin.listeners.partialResults!({ matches: [text] })
}

describe('dictation in the iOS app', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    plugin.listeners = {}
    plugin.starts = 0
  })
  afterEach(() => vi.useRealTimers())

  async function dictate() {
    const onText = vi.fn()
    const onEnd = vi.fn()
    const d = startNativeDictation({ lang: 'en-US', onText, onEnd })
    await settle()
    expect(plugin.starts).toBe(1)
    return { d, onText, onEnd }
  }

  // The owner's report (2026-11-24): only the last phrase survived.
  it('keeps every phrase when Apple starts a new segment after a pause in one run', async () => {
    const { onText } = await dictate()
    partial('Check')
    partial('Check the')
    partial('Check the build')
    partial('Check the build.', 400)
    // A pause; the next partial holds only the words since.
    partial('Then', 1800)
    partial('Then deploy')
    partial('Then deploy it')
    partial('Fine', 2000)
    expect(onText).toHaveBeenLastCalledWith('Check the build. Then deploy it Fine')
    expect(plugin.starts).toBe(1)
  })

  it('keeps a phrase when the new one starts with the same word', async () => {
    const { onText } = await dictate()
    partial('I want')
    partial('I want coffee')
    partial('I', 2000)
    partial('I think')
    expect(onText).toHaveBeenLastCalledWith('I want coffee I think')
  })

  it('takes revisions, punctuation and case changes without saying words twice', async () => {
    const { onText } = await dictate()
    partial('turn')
    partial('turn of')
    partial('Turn off the')
    partial('Turn off the lights')
    partial('Turn off the lights.', 300)
    // A new phrase after a pause, then rewritten mid-phrase: revisions.
    partial('Ice', 900)
    expect(onText).toHaveBeenLastCalledWith('Turn off the lights. Ice')
    partial('I scream')
    partial('Ice cream is')
    partial('Ice cream is cold')
    expect(onText).toHaveBeenLastCalledWith('Turn off the lights. Ice cream is cold')
  })

  it('keeps every word across a run that ends by itself, and none twice', async () => {
    const { d, onText, onEnd } = await dictate()
    partial('One phrase')
    plugin.listeners.listeningState!({ state: 'stopped' })
    await settle()
    expect(plugin.starts).toBe(2)
    partial('another', 2000)
    partial('another one')
    expect(onText).toHaveBeenLastCalledWith('One phrase another one')
    d.stop()
    await settle()
    expect(onEnd).toHaveBeenCalledWith(undefined)
  })

  it('never wipes the words shown with an empty result', async () => {
    const { onText } = await dictate()
    partial('Keep this')
    partial('', 2000)
    expect(onText).toHaveBeenLastCalledWith('Keep this')
  })
})
