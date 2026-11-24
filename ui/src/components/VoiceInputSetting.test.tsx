/**
 * Settings → Voice input (ADR-104) with the shell stubbed: each state of the
 * voice model's block — not downloaded, downloading, installed, failed, an
 * old processor — and that it is drawn only where the shell offers a model.
 * Nothing is downloaded: `voice_model_*` answer from the test.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDeskVoice, useDeskVoiceStatus } from '@/lib/deskvoice'
import type { VoiceModelStatus } from '@/lib/shell'
import { failureText, mb, VoiceInputSetting } from './VoiceInputSetting'

/** A microphone elsewhere on the page: what the shell's dictation status says to it now. */
function Mic() {
  const s = useDeskVoiceStatus()
  return <span data-testid="mic-status">{s ? (s.reason ?? 'ready') : 'none'}</span>
}

const MODELS: VoiceModelStatus['models'] = [
  { id: 'small', file: 'ggml-small-q5_1.bin', bytes: 190_085_487 + 885_098 },
  { id: 'base', file: 'ggml-base.bin', bytes: 147_951_465 + 885_098 },
]
const DIR = 'C:\\Users\\me\\AppData\\Local\\dev.caprock.app\\voice'

let status: VoiceModelStatus
let dictation: Record<string, unknown>
let invoke: ReturnType<typeof vi.fn>

function base(over: Partial<VoiceModelStatus> = {}): VoiceModelStatus {
  return { offered: true, cpu_ok: true, dir: DIR, models: MODELS, ...over }
}

beforeEach(() => {
  status = base()
  dictation = { supported: false, reason: 'no-model', engine: 'whisper' }
  resetDeskVoice()
  invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'voice_model_status') return status
    if (cmd === 'dictation_status') return dictation
    if (cmd.startsWith('voice_model_')) return null
    throw new Error(`unexpected ${cmd}`)
  })
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  localStorage.clear()
  vi.useRealTimers()
})

describe('Settings → Voice input', () => {
  it('before the model: the two models, Accurate picked, and a download that says what goes where', async () => {
    render(<><VoiceInputSetting /><Mic /></>)
    expect(await screen.findByTestId('mic-status')).toHaveTextContent('no-model')
    const dl = await screen.findByRole('button', { name: /^Download voice model · 191 MB$/ })
    const accurate = screen.getByRole('radio', { name: /Accurate · small, 191 MB/ })
    expect(accurate).toHaveAttribute('aria-checked', 'true')
    expect(accurate).toHaveTextContent('Recommended')
    expect(screen.getByRole('radio', { name: /Fast · base, 149 MB/ })).toHaveTextContent('Misses more words, often in Russian')
    // Rule 4: the source, the checksum, nothing else sent, the voice stays — kept even with explanations hidden.
    const note = document.querySelector('[data-voice-download-note]')!
    expect(note).toHaveAttribute('data-keep')
    expect(note).toHaveTextContent('huggingface.co')
    expect(note).toHaveTextContent('SHA-256')
    expect(note).toHaveTextContent('Nothing else is sent')
    expect(note).toHaveTextContent('your voice never leaves this computer')
    // Picking Fast changes what the button downloads.
    fireEvent.click(screen.getByRole('radio', { name: /Fast · base/ }))
    expect(screen.getByRole('button', { name: /^Download voice model · 149 MB$/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Accurate · small/ }))
    expect(invoke).not.toHaveBeenCalledWith('voice_model_download', expect.anything())
    status = base({ download: { model: 'small', done: 0, total: MODELS[0]!.bytes } })
    dictation = { supported: false, reason: 'downloading', engine: 'whisper' }
    fireEvent.click(dl)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_model_download', { model: 'small' }))
    // The mic is told: it now says the model is coming.
    await waitFor(() => expect(screen.getByTestId('mic-status')).toHaveTextContent('downloading'))
    expect(await screen.findByRole('progressbar', { name: 'Voice model download' })).toBeInTheDocument()
  })

  it('while it downloads: how far, Cancel, the models locked; and it follows the download to the end', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    status = base({ download: { model: 'small', done: 112_000_000, total: MODELS[0]!.bytes } })
    dictation = { supported: false, reason: 'downloading', engine: 'whisper' }
    render(<><VoiceInputSetting /><Mic /></>)
    expect(await screen.findByTestId('mic-status')).toHaveTextContent('downloading')
    const bar = await screen.findByRole('progressbar', { name: 'Voice model download' })
    expect(bar).toHaveAttribute('aria-valuenow', '59')
    expect(screen.getByText('112 of 191 MB')).toBeInTheDocument()
    expect(screen.getByText(/the mic turns on when it is done/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Fast · base/ })).toBeDisabled()
    // Done: the poll sees it installed and tells the mic.
    status = base({ installed: 'small', path: `${DIR}\\ggml-small-q5_1.bin` })
    dictation = { supported: true, engine: 'whisper' }
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(await screen.findByText(/Installed · small · 191 MB · checksum verified/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('mic-status')).toHaveTextContent('ready'))
  })

  it('Cancel stops it', async () => {
    status = base({ download: { model: 'base', done: 1, total: 2 } })
    render(<VoiceInputSetting />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_model_cancel', {}))
  })

  it('installed: where it is, Show in folder, Remove; the other model replaces it', async () => {
    status = base({ installed: 'small', path: `${DIR}\\ggml-small-q5_1.bin` })
    render(<VoiceInputSetting />)
    expect(await screen.findByText(`${DIR}\\ggml-small-q5_1.bin`)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_model_reveal', {}))
    fireEvent.click(screen.getByRole('radio', { name: /Fast · base/ }))
    expect(screen.getByRole('button', { name: /^Download voice model · 149 MB \(replaces small\)$/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Accurate · small/ }))
    status = base()
    fireEvent.click(screen.getByRole('button', { name: 'Remove voice model' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_model_remove', {}))
    expect(await screen.findByRole('button', { name: /^Download voice model/ })).toBeInTheDocument()
  })

  it('a failed download says why and offers Try again', async () => {
    status = base({ error: { model: 'small', error: 'checksum' } })
    render(<VoiceInputSetting />)
    expect(await screen.findByRole('alert')).toHaveTextContent("The download didn't match its checksum, so it was deleted. Nothing was installed.")
    fireEvent.click(screen.getByRole('button', { name: /^Try again · 191 MB$/ }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_model_download', { model: 'small' }))
    expect(failureText('network')).toContain('huggingface.co could not be reached')
    expect(failureText('disk', DIR)).toContain(DIR)
  })

  it('a processor without AVX2 is told so and offered no download', async () => {
    status = base({ cpu_ok: false })
    render(<VoiceInputSetting />)
    expect(await screen.findByText(/lacks AVX2/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Download voice model/ })).toBeNull()
  })

  it('is not drawn on a Mac, nor in a browser tab', async () => {
    status = base({ offered: false })
    render(<VoiceInputSetting />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_model_status', {}))
    expect(screen.queryByText('Voice input')).toBeNull()
    cleanup()
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    render(<VoiceInputSetting />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText('Voice input')).toBeNull()
  })

  it('sizes read as whole megabytes', () => {
    expect(mb(190_085_487)).toBe('190 MB')
    expect(mb(MODELS[1]!.bytes)).toBe('149 MB')
  })
})
