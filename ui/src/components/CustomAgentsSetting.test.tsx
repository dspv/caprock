import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, customAgents: async () => ({ agents: [] }), saveCustomAgents: m.save } }
})

import { CustomAgentsEditor, parseArgs, parseModels } from './CustomAgentsSetting'

describe('custom agents', () => {
  it('reads arguments one per line and models comma-separated', () => {
    expect(parseArgs(' --model\n{model}\n\n--message\n{prompt} ')).toEqual(['--model', '{model}', '--message', '{prompt}'])
    expect(parseArgs('--title\na title with spaces')).toEqual(['--title', 'a title with spaces'])
    expect(parseModels('gpt-5.5, sonnet ,')).toEqual(['gpt-5.5', 'sonnet'])
  })

  it('saves a new agent and lists it, and says what the daemon refused', async () => {
    m.save.mockResolvedValueOnce({ agents: [{ id: 'aider', name: 'Aider', command: 'aider', args: ['--message', '{prompt}'], models: ['gpt-5.5'] }] })
    render(<CustomAgentsEditor />)
    fireEvent.change(screen.getByPlaceholderText('Aider'), { target: { value: 'Aider' } })
    fireEvent.change(screen.getByPlaceholderText('aider'), { target: { value: 'aider' } })
    fireEvent.change(screen.getByRole('textbox', { name: /Arguments/ }), { target: { value: '--message\n{prompt}' } })
    fireEvent.change(screen.getByRole('textbox', { name: /Models/ }), { target: { value: 'gpt-5.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }))
    await waitFor(() => expect(m.save).toHaveBeenCalledWith([{ name: 'Aider', command: 'aider', args: ['--message', '{prompt}'], models: ['gpt-5.5'] }]))
    expect(await screen.findByRole('list', { name: 'Custom agents' })).toHaveTextContent('aider --message {prompt}')

    m.save.mockRejectedValueOnce(new Error('premium required'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('premium required')
  })
})
