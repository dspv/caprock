import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const m = vi.hoisted(() => ({ list: vi.fn(), add: vi.fn(), patch: vi.fn(), refresh: vi.fn(), remove: vi.fn() }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, brainVaults: m.list, addBrainVault: m.add, patchBrainVault: m.patch, refreshBrainVault: m.refresh, removeBrainVault: m.remove } }
})
import { ObsidianVaults } from './ObsidianVaults'

const vault = { id: 7, name: 'My notes', path: '/notes/vault', agents: false, notes: 12, scan_ms: 10, scanned_at: Date.now(), created_at: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  m.list.mockResolvedValue({ vaults: [] })
  m.add.mockResolvedValue({ vault })
  m.patch.mockResolvedValue({ vault })
  m.refresh.mockResolvedValue({ vault })
  m.remove.mockResolvedValue({ removed: true })
})

describe('Obsidian import', () => {
  it('imports with agent sharing off unless the user chooses it, and explains where notes go', async () => {
    render(<ObsidianVaults onClose={() => {}} />)
    const share = screen.getByRole('checkbox', { name: 'Let agents use these notes' })
    expect(share).not.toBeChecked()
    expect(screen.getByText(/Off keeps imported notes in Caprock/)).toHaveTextContent(/model your agent uses/)
    fireEvent.change(screen.getByRole('textbox', { name: 'Vault folder' }), { target: { value: '/notes/vault' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import vault' }))
    await waitFor(() => expect(m.add).toHaveBeenCalledWith('/notes/vault', false))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Vault folder' })).toHaveValue(''))
  })

  it('lets the user explicitly share a new vault', async () => {
    render(<ObsidianVaults onClose={() => {}} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Vault folder' }), { target: { value: '/notes/shared' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Let agents use these notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import vault' }))
    await waitFor(() => expect(m.add).toHaveBeenCalledWith('/notes/shared', true))
  })

  it('refreshes, changes consent and confirms removing an import', async () => {
    m.list.mockResolvedValue({ vaults: [vault] })
    render(<ObsidianVaults onClose={() => {}} />)
    await screen.findByRole('heading', { name: 'My notes' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Let agents use My notes' }))
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith(7, true))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh now' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }))
    await waitFor(() => expect(m.refresh).toHaveBeenCalledWith(7))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove…' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Remove…' }))
    expect(m.remove).not.toHaveBeenCalled()
    expect(screen.getByText(/Your files stay/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Remove import' }))
    await waitFor(() => expect(m.remove).toHaveBeenCalledWith(7))
  })

  it('shows import errors and keeps the path for correction', async () => {
    m.add.mockRejectedValue(new Error('not a folder on this computer'))
    render(<ObsidianVaults onClose={() => {}} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Vault folder' }), { target: { value: '/missing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import vault' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('not a folder on this computer')
    expect(screen.getByRole('textbox', { name: 'Vault folder' })).toHaveValue('/missing')
    expect(screen.getByRole('button', { name: 'Import vault' })).toBeEnabled()
  })
})
