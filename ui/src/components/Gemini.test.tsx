/**
 * The Gemini panel has to keep two absences apart.
 *
 * "No key" is setup with a free fix. "No licence" is a purchase. Merging them
 * into one greyed-out button tells a reader who has not pasted a key that they
 * should pay, which is both wrong and the kind of wrong that gets a refund
 * request.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { GeminiPanel } from './Gemini'
import type { GeminiStatus, Settings } from '@/lib/api'

const status = vi.hoisted(() => ({ value: {} as GeminiStatus }))
const saved = vi.hoisted(() => ({ calls: [] as Partial<Settings>[] }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      gemini: async () => status.value,
      saveSettings: async (s: Settings) => {
        saved.calls.push(s)
        return s
      },
    },
  }
})

describe('GeminiPanel', () => {
  // A login agent inherits nothing from a shell profile, so "export it" was no
  // instruction at all for anyone who ran `caprock service install` — which is
  // the setup the product recommends (ADR-025).
  it('offers a field to paste the key into', async () => {
    status.value = { available: false, env_var: 'GEMINI_API_KEY', licensed: true, model: 'gemini-3.5-flash-lite' }
    render(<GeminiPanel />)
    await waitFor(() => expect(screen.getByPlaceholderText('AIza…')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /save key/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^ask$/i })).not.toBeInTheDocument()
  })

  it('saves the key and asks for nothing else', async () => {
    saved.calls = []
    status.value = { available: false, env_var: 'GEMINI_API_KEY', licensed: true, model: 'm' }
    render(<GeminiPanel />)
    const field = await screen.findByPlaceholderText('AIza…')
    fireEvent.change(field, { target: { value: 'AIza-test' } })
    fireEvent.click(screen.getByRole('button', { name: /save key/i }))
    await waitFor(() => expect(saved.calls.length).toBe(1))
    // Only the key: a settings write that carries other fields can undo them.
    expect(saved.calls[0]).toEqual({ gemini_api_key: 'AIza-test' })
  })

  it('says where the key lives and who bills for it', async () => {
    status.value = { available: false, env_var: 'GEMINI_API_KEY', licensed: true, model: 'm' }
    render(<GeminiPanel />)
    await waitFor(() => expect(screen.getByText(/never sent back to this page/i)).toBeInTheDocument())
    expect(screen.getByText(/pay Google directly/i)).toBeInTheDocument()
  })

  it('shows the setup step whether or not they have paid', async () => {
    status.value = { available: false, env_var: 'GEMINI_API_KEY', licensed: false, model: 'm' }
    render(<GeminiPanel />)
    await waitFor(() => expect(screen.getByPlaceholderText('AIza…')).toBeInTheDocument())
  })

  it('offers the box once a key is set', async () => {
    status.value = { available: true, env_var: 'GEMINI_API_KEY', licensed: true, model: 'gemini-3.5-flash-lite' }
    render(<GeminiPanel />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^ask$/i })).toBeInTheDocument())
    expect(screen.getByPlaceholderText(/ask about your sessions/i)).toBeInTheDocument()
    // The model is named: it is the reader's money, and models differ by
    // twenty-five times.
    expect(screen.getByText('gemini-3.5-flash-lite')).toBeInTheDocument()
  })

  it('will not send an empty question', async () => {
    status.value = { available: true, env_var: 'GEMINI_API_KEY', licensed: true, model: 'm' }
    render(<GeminiPanel />)
    expect(await screen.findByRole('button', { name: /^ask$/i })).toBeDisabled()
  })

  // The environment still wins where it is set, so a machine configured that
  // way keeps working — and the panel says which source it is using, or
  // editing a field that changes nothing is baffling.
  it('says when the environment is supplying the key', async () => {
    status.value = { available: true, from_env: true, env_var: 'GEMINI_API_KEY', licensed: true, model: 'm' }
    render(<GeminiPanel />)
    await waitFor(() => expect(screen.getByText(/takes precedence/i)).toBeInTheDocument())
  })

  it('says when the stored key is the one in use', async () => {
    status.value = { available: true, from_env: false, env_var: 'GEMINI_API_KEY', licensed: true, model: 'm' }
    render(<GeminiPanel />)
    await waitFor(() => expect(screen.getByText(/key you saved here/i)).toBeInTheDocument())
  })
})

describe('choosing a model', () => {
  const withModels = (): GeminiStatus => ({
    available: true, env_var: 'GEMINI_API_KEY', licensed: true,
    model: 'gemini-3.5-flash-lite',
    models: [
      { id: 'gemini-2.5-flash-lite', display: 'Gemini 2.5 Flash Lite', input: 0.1, output: 0.4, typical_usd: 0.0004 },
      { id: 'gemini-3.1-pro-preview', display: 'Gemini 3.1 Pro', input: 2, output: 12, typical_usd: 0.01 },
    ],
  })

  it('prices each model, because they differ by twenty-five times', async () => {
    status.value = withModels()
    render(<GeminiPanel />)
    expect(await screen.findByLabelText('Model')).toBeInTheDocument()
    // Sub-cent prices must not round to "$0.00": a reader who believes a
    // question is free will believe it fifty times.
    expect(screen.getByText(/Flash Lite · ~0.0¢ a question/)).toBeInTheDocument()
    expect(screen.getByText(/Pro · ~\$0.01 a question/)).toBeInTheDocument()
  })

  it('offers no picker when the daemon sent no models', async () => {
    status.value = { available: true, env_var: 'GEMINI_API_KEY', licensed: true, model: 'm' }
    render(<GeminiPanel />)
    await screen.findByRole('button', { name: /^ask$/i })
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument()
  })
})
