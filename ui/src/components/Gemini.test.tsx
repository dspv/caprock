/**
 * The Gemini panel has to keep two absences apart.
 *
 * "No key" is a setup problem with a free fix — a variable name. "No licence"
 * is a purchase. Merging them into one greyed-out button tells a reader who
 * has not set the variable that they should pay, which is both wrong and the
 * kind of wrong that gets a refund request.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { GeminiPanel } from './Gemini'
import type { GeminiStatus } from '@/lib/api'

const status = vi.hoisted(() => ({ value: {} as GeminiStatus }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, gemini: async () => status.value } }
})

describe('GeminiPanel', () => {
  it('names the variable to set when there is no key', async () => {
    status.value = { available: false, env_var: 'GEMINI_API_KEY', licensed: true, model: 'gemini-3.5-flash-lite' }
    render(<GeminiPanel />)
    // The fix, not a paywall: this reader has nothing to buy.
    await waitFor(() => expect(screen.getByText(/GEMINI_API_KEY/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /ask/i })).not.toBeInTheDocument()
  })

  it('says the key stays with the user, since that is the whole trade', async () => {
    status.value = { available: false, env_var: 'GEMINI_API_KEY', licensed: true, model: 'm' }
    render(<GeminiPanel />)
    await waitFor(() => expect(screen.getByText(/never stores the key/i)).toBeInTheDocument())
    // And who gets paid, so nobody expects Caprock to be reselling tokens.
    expect(screen.getByText(/pay Google directly/i)).toBeInTheDocument()
  })

  it('offers the box once a key is set', async () => {
    status.value = { available: true, env_var: 'GEMINI_API_KEY', licensed: true, model: 'gemini-3.5-flash-lite' }
    render(<GeminiPanel />)
    await waitFor(() => expect(screen.getByRole('button', { name: /ask/i })).toBeInTheDocument())
    expect(screen.getByPlaceholderText(/ask about your sessions/i)).toBeInTheDocument()
    // The model is named: it is the reader's money, and different models cost
    // very different amounts.
    expect(screen.getByText('gemini-3.5-flash-lite')).toBeInTheDocument()
  })

  it('will not send an empty question', async () => {
    status.value = { available: true, env_var: 'GEMINI_API_KEY', licensed: true, model: 'm' }
    render(<GeminiPanel />)
    const btn = await screen.findByRole('button', { name: /ask/i })
    expect(btn).toBeDisabled()
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
    const select = await screen.findByLabelText('Model')
    expect(select).toBeInTheDocument()
    // Sub-cent prices must not round to "$0.00": a reader who believes a
    // question is free will believe it fifty times.
    expect(screen.getByText(/Flash Lite · ~0.0¢ a question/)).toBeInTheDocument()
    expect(screen.getByText(/Pro · ~\$0.01 a question/)).toBeInTheDocument()
  })

  it('offers no picker when the daemon sent no models', async () => {
    status.value = { available: true, env_var: 'GEMINI_API_KEY', licensed: true, model: 'm' }
    render(<GeminiPanel />)
    await screen.findByRole('button', { name: /ask/i })
    // An older daemon that does not send the list must not produce an empty
    // dropdown next to the button.
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument()
  })
})
