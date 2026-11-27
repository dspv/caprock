import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SendSecrets } from './SendSecrets'
import { latestByComputer, secretNames, type SecretItem } from '@/lib/secretshare'

const ID = 'winPC1000000000000000000000000000000000000AB'

const items: SecretItem[] = [
  { name: 'github', label: 'GitHub token', set: true },
  { name: 'deepseek', label: 'DeepSeek key', set: true },
  { name: 'kimi', label: 'Kimi key', set: false },
]

function answer(by: (method: string, path: string, body: unknown) => { status?: number; body: unknown }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = new URL(String(input), 'http://x')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const out = by(init?.method ?? 'GET', u.pathname, body)
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 })
  })
}

describe('secretNames', () => {
  it('joins labels the way a sentence does', () => {
    expect(secretNames(['deepseek'])).toBe('DeepSeek key')
    expect(secretNames(['github', 'deepseek', 'kimi'])).toBe('GitHub token, DeepSeek key and Kimi key')
  })

  it('keeps the newest arrival from each computer', () => {
    const m = latestByComputer([
      { from_id: 'a', from: 'MacBook', names: ['kimi'], at: 1 },
      { from_id: 'a', from: 'MacBook', names: ['deepseek'], at: 5 },
      { from_id: 'b', from: 'Mini', names: ['github'], at: 2 },
    ])
    expect(m.get('a')?.names).toEqual(['deepseek'])
    expect(m.get('b')?.from).toBe('Mini')
  })
})

describe('Send secrets', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('sends only what was ticked, on the click, and says what the computer kept', async () => {
    const sent: unknown[] = []
    answer((method, path, body) => {
      if (method === 'GET' && path === '/v1/machines/secrets') return { body: { secrets: items } }
      if (method === 'POST' && path === `/v1/machines/${ID}/secrets`) {
        sent.push(body)
        return { body: { stored: ['deepseek'], failed: [] } }
      }
      return { status: 404, body: {} }
    })
    render(<SendSecrets m={{ id: ID, name: 'Windows PC' }} />)
    const ds = await screen.findByRole('checkbox', { name: /DeepSeek key/ })
    expect(ds).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Kimi key/ })).toBeDisabled()
    const go = screen.getByRole('button', { name: 'Send' })
    expect(go).toBeDisabled()
    expect(sent).toEqual([])
    fireEvent.click(ds)
    fireEvent.click(screen.getByRole('button', { name: 'Send 1 to Windows PC' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Windows PC keeps the DeepSeek key now.'))
    expect(sent).toEqual([{ names: ['deepseek'] }])
  })

  it('names what the computer could not keep, and an older Caprock there', async () => {
    let older = false
    answer((method) => {
      if (method === 'GET') return { body: { secrets: items } }
      if (older) return { status: 501, body: { error: 'that computer runs a Caprock from before Send secrets: update Caprock there first' } }
      return { body: { stored: [], failed: [{ name: 'github', error: 'GitHub refused the token' }] } }
    })
    render(<SendSecrets m={{ id: ID, name: 'Windows PC' }} />)
    fireEvent.click(await screen.findByRole('checkbox', { name: /GitHub token/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Send 1 to Windows PC' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('GitHub token: GitHub refused the token'))
    older = true
    fireEvent.click(screen.getByRole('button', { name: 'Send 1 to Windows PC' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('update Caprock there first'))
  })
})
