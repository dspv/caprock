/**
 * Mail's AI settings: the provider picker shows what this computer has, says
 * where the mail text goes, and keeps an API key write-only.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from './Setup'
import { api, type AIProvider, type AIStatus } from './mailApi'

const row = (p: Partial<AIProvider> & { id: string; label: string; kind: AIProvider['kind'] }): AIProvider =>
  ({ sends_to: '', available: false, model: '', ...p })

const providers: AIProvider[] = [
  row({ id: 'claude', label: 'Claude Code', kind: 'cli', available: true, model_hint: 'haiku, sonnet or opus', sends_to: 'Anthropic, through your Claude Code login' }),
  row({ id: 'codex', label: 'Codex', kind: 'cli', why: '`codex` is not installed on this computer' }),
  row({ id: 'anthropic', label: 'Anthropic API', kind: 'api', why: 'no API key yet', sends_to: 'api.anthropic.com, with your API key' }),
  row({ id: 'local', label: 'Local model', kind: 'local', why: 'no local model server is running' }),
]

const auto: AIStatus = { chosen: '', provider: 'claude', label: 'Claude Code', sends_to: 'Anthropic, through your Claude Code login', available: true, models: [], providers }

beforeEach(() => {
  vi.restoreAllMocks()
})

function panel(settings: Record<string, string>) {
  const onSettings = vi.fn()
  vi.spyOn(api, 'putSettings').mockImplementation(async (s) => ({ ...settings, ...s }))
  render(<SettingsPanel accounts={[]} settings={settings} onSettings={onSettings} onClose={() => {}} onChanged={() => {}} />)
  return onSettings
}

describe('mail AI settings', () => {
  it('automatic uses the installed CLI and says where mail goes', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(auto)
    panel({ ai_enabled: '1', ai_provider: '' })
    await screen.findByText(/Mail text goes to Anthropic, through your Claude Code login/)
    const sel = screen.getByLabelText('AI provider') as HTMLSelectElement
    expect(sel.value).toBe('')
    expect(screen.getByRole('option', { name: 'Automatic (Claude Code)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Codex (not installed)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Anthropic API (needs a key)' })).toBeTruthy()
    // A CLI takes a model but never a key.
    expect(screen.getByLabelText('AI model')).toBeTruthy()
    expect(screen.queryByLabelText('Claude Code key')).toBeNull()
  })

  it('an API provider takes a key that is saved and never shown again', async () => {
    const status = vi.spyOn(api, 'aiStatus').mockResolvedValue({ ...auto, chosen: 'anthropic', provider: 'anthropic', label: 'Anthropic API', available: false, error: 'no API key yet' })
    const put = vi.spyOn(api, 'aiKey').mockResolvedValue({ ok: true, key_set: true })
    panel({ ai_enabled: '1', ai_provider: 'anthropic' })
    await screen.findByText(/no API key yet/)
    const input = screen.getByLabelText('Anthropic API key') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: ' sk-ant-1 ' } })
    status.mockResolvedValue({ ...auto, chosen: 'anthropic', provider: 'anthropic', label: 'Anthropic API', sends_to: 'api.anthropic.com, with your API key',
      providers: providers.map((p) => (p.id === 'anthropic' ? { ...p, available: true, key_set: true, key_where: { kind: 'keychain' } } : p)) })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toHaveBeenCalledWith('anthropic', 'sk-ant-1'))
    await screen.findByText(/Mail text goes to api.anthropic.com/)
    expect((screen.getByLabelText('Anthropic API key') as HTMLInputElement).value).toBe('')
    expect(screen.getByPlaceholderText('Saved in your keychain')).toBeTruthy()
  })

  it('choosing a provider saves it', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(auto)
    const onSettings = panel({ ai_enabled: '1', ai_provider: '' })
    await screen.findByText(/Mail text goes to/)
    fireEvent.change(screen.getByLabelText('AI provider'), { target: { value: 'local' } })
    await waitFor(() => expect(api.putSettings).toHaveBeenCalledWith({ ai_provider: 'local' }))
    await waitFor(() => expect(onSettings).toHaveBeenCalled())
  })

  it('an older daemon without providers still renders', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue({ ...auto, provider: '', label: '', available: false, error: 'no local model server is running', providers: [] })
    panel({ ai_enabled: '0' })
    await screen.findByText(/no local model server is running/)
  })
})
