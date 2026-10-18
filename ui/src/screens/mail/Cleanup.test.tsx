import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { Cleanup } from './Cleanup'
import { api } from './mailApi'

beforeEach(() => vi.restoreAllMocks())

it('reviews the snapshot before moving spam', async () => {
  const preview = vi.spyOn(api, 'cleanupPreview').mockResolvedValue({ ids: [1, 3, 9], identities: {} })
  const execute = vi.spyOn(api, 'cleanup').mockResolvedValue({ ok: true })
  const changed = vi.fn()
  render(<Cleanup view="junk" account={7} accountName="me@example.com" onChanged={changed} />)
  expect(preview).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Clean spam → Trash'))
  await screen.findByText('3 messages match.')
  expect(execute).not.toHaveBeenCalled()
  expect(preview).toHaveBeenCalledWith({ view: 'junk', account: 7, before: 0, min_score: 0 })
  fireEvent.click(screen.getByText('Move 3 to Trash'))
  await waitFor(() => expect(changed).toHaveBeenCalledWith('Spam moved to Trash'))
  expect(execute).toHaveBeenCalledWith({ view: 'junk', account: 7, before: 0, min_score: 0, ids: [1, 3, 9], identities: {} })
})

it('defaults Trash to 30 days and ignores obsolete counts when filters change', async () => {
  let oldResult!: (value: { ids: number[]; identities: Record<string, string> }) => void
  const preview = vi.spyOn(api, 'cleanupPreview')
    .mockImplementationOnce(() => new Promise((resolve) => { oldResult = resolve }))
    .mockResolvedValue({ ids: [8], identities: {} })
  const execute = vi.spyOn(api, 'cleanup').mockResolvedValue({ ok: true })
  const now = Date.now()
  render(<Cleanup view="trash" onChanged={vi.fn()} />)
  fireEvent.click(screen.getByText('Clean Trash…'))
  expect(preview.mock.calls[0]![0].before).toBeGreaterThanOrEqual(now - 30 * 86_400_000)
  expect(screen.getByText('Delete 0 forever')).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Spam score'), { target: { value: '90' } })
  await screen.findByText('1 message match.')
  await act(async () => oldResult({ ids: [1, 2, 3], identities: {} }))
  expect(screen.queryByText('3 messages match.')).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Message age'), { target: { value: '0' } })
  await waitFor(() => expect(screen.getByText('Delete 1 forever')).toBeEnabled())
  expect(screen.getByText(/permanently deleted from the mail server/)).toBeInTheDocument()
  fireEvent.click(screen.getByText('Delete 1 forever'))
  await waitFor(() => expect(execute).toHaveBeenCalledWith({ view: 'trash', account: 0, before: 0, min_score: 90, ids: [8], identities: {} }))
})

it('requires a new preview after a failure and cancel does not mutate mail', async () => {
  const preview = vi.spyOn(api, 'cleanupPreview').mockResolvedValue({ ids: [8], identities: {} })
  const execute = vi.spyOn(api, 'cleanup').mockRejectedValue(new Error('Connection lost; refresh before retrying'))
  const changed = vi.fn()
  render(<Cleanup view="trash" onChanged={changed} />)
  fireEvent.click(screen.getByText('Clean Trash…'))
  await screen.findByText('1 message match.')
  fireEvent.click(screen.getByText('Delete 1 forever'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost')
  expect(changed).toHaveBeenCalledWith()
  expect(screen.getByText('Delete 0 forever')).toBeDisabled()
  fireEvent.click(screen.getByText('Refresh preview'))
  await screen.findByText('1 message match.')
  expect(preview).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByText('Cancel'))
  expect(execute).toHaveBeenCalledTimes(1)
})
