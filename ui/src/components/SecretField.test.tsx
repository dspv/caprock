/**
 * The secure field's three states — empty, typing, saved — and the (i)
 * dialog. Nothing saved is ever put back into a text field.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SecretField, whereText, type SecretProvider } from './SecretField'

const provider: SecretProvider = {
  name: 'DeepSeek',
  host: 'api.deepseek.com',
  sentWhen: 'from the environment of a session you start on DeepSeek.',
  revokeAt: 'platform.deepseek.com/api_keys',
  revokeHow: 'delete the key there.',
}

function field(over: Partial<Parameters<typeof SecretField>[0]> = {}) {
  const onSave = vi.fn(async () => {})
  const onRemove = vi.fn(async () => {})
  render(<SecretField label="DeepSeek API key" what="DeepSeek key" set={false} provider={provider} saveLabel="Save key" onSave={onSave} onRemove={onRemove} {...over} />)
  return { onSave, onRemove }
}

describe('SecretField', () => {
  it('empty: a masked secure input, no eye until something is typed', () => {
    field()
    const input = screen.getByLabelText('DeepSeek API key')
    expect(input).toHaveAttribute('type', 'password')
    expect(input.closest('[data-secret-input]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /what you typed/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save key' })).toBeDisabled()
  })

  it('typing: the eye shows and hides what was typed; Save sends it trimmed', async () => {
    const { onSave } = field()
    const input = screen.getByLabelText('DeepSeek API key')
    fireEvent.change(input, { target: { value: '  sk-typed-1234  ' } })
    const eye = screen.getByRole('button', { name: 'Show what you typed' })
    fireEvent.click(eye)
    expect(input).toHaveAttribute('type', 'text')
    fireEvent.click(screen.getByRole('button', { name: 'Hide what you typed' }))
    expect(input).toHaveAttribute('type', 'password')
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('sk-typed-1234'))
  })

  it('saved: a locked pill with the hint and where it is kept, no text field; Replace and Remove', async () => {
    const { onSave, onRemove } = field({ set: true, hint: 'sk-…1a2b', where: { kind: 'keychain' } })
    expect(screen.queryByLabelText('DeepSeek API key')).toBeNull()
    expect(screen.getByText('sk-…1a2b')).toBeInTheDocument()
    expect(screen.getByText(/in macOS Keychain/)).toBeInTheDocument()
    expect(screen.getByText(/Stored in your macOS login keychain/)).toBeInTheDocument()
    expect(screen.getByText(/Remove deletes it from the keychain/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    const input = screen.getByLabelText('DeepSeek API key')
    expect(input).toHaveValue('')
    fireEvent.change(input, { target: { value: 'sk-new-9999' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('sk-new-9999'))

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(onRemove).toHaveBeenCalled())
  })

  it('a file store names its path', () => {
    field({ set: true, hint: 'sk-…1a2b', where: { kind: 'file', path: '/home/u/.local/share/caprock/deepseek-api-key' } })
    expect(screen.getByText(/Stored in a file only your user can read: \/home\/u\/\.local\/share\/caprock\/deepseek-api-key/)).toBeInTheDocument()
    expect(screen.getByText(/Remove deletes it from the file/)).toBeInTheDocument()
  })

  it('shows a refused save and stays editable', async () => {
    field({ onSave: vi.fn(async () => { throw new Error('the Keychain refused') }) })
    const input = screen.getByLabelText('DeepSeek API key')
    fireEvent.change(input, { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('the Keychain refused')
    expect(screen.getByLabelText('DeepSeek API key')).toBeInTheDocument()
  })

  it('(i) opens a dialog: where, sent to, never shown, backups, remove and revoke', () => {
    field({ set: true, hint: 'sk-…1a2b', where: { kind: 'keychain' } })
    fireEvent.click(screen.getByRole('button', { name: 'How the DeepSeek key is kept' }))
    const dlg = screen.getByRole('dialog', { name: 'How your DeepSeek key is kept' })
    const d = within(dlg)
    expect(d.getByText(/Stored in your macOS login keychain/)).toBeInTheDocument()
    expect(d.getByText('api.deepseek.com')).toBeInTheDocument()
    expect(d.getByText(/Never\. After saving, Caprock shows only/)).toBeInTheDocument()
    expect(d.getByText(/Time Machine backs up the login keychain encrypted/)).toBeInTheDocument()
    expect(d.getByText('platform.deepseek.com/api_keys')).toBeInTheDocument()
    fireEvent.click(d.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('whereText', () => {
  it('says where, per store', () => {
    expect(whereText({ kind: 'keychain' })).toBe('Stored in your macOS login keychain')
    expect(whereText({ kind: 'file', path: 'C:\\Users\\u\\AppData\\Roaming\\caprock\\telegram-bot-token' })).toBe('Stored in a file only your user can read: C:\\Users\\u\\AppData\\Roaming\\caprock\\telegram-bot-token')
    expect(whereText(undefined, true)).toMatch(/Will be stored in your macOS login keychain/)
    expect(whereText(undefined, false)).toMatch(/Will be stored in a file/)
  })
})
