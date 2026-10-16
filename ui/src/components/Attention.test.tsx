/**
 * A "Waiting for you" row is one big way back into the waiting session
 * (owner, 2026-10-16, translated: "from here I want to go straight to the
 * right terminal with one big button"). These pin that a click anywhere on
 * the row, Enter on it, and its *Open terminal →* all go there; that *what did
 * it ask?* opens the answer in place without leaving; and that the row names
 * the session, not only the project.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Attention } from './Attention'
import type { AttentionItem } from '@/lib/attention'
import type { SessionSummary } from '@/lib/api'
import { PipelineHostContext } from '@/lib/pipelineHost'

const notes = vi.hoisted(() => ({ calls: 0 }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, notes: async () => { notes.calls++; return [] } } }
})

const NOW = Date.parse('2026-10-16T12:00:00Z')

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: 'abc12345', project: 'caprock-web', owned: true, status: 'active', last_event_at: NOW,
    title: 'Fix the pricing page',
    activity: { health: 'waiting-on-you', phrase: 'waiting for you', at: '' },
    stats: { cost_usd: 1, turns: 1, tool_calls: 1, files_touched: 1 },
    ...over,
  } as unknown as SessionSummary
}

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: 'waiting-abc12345', sessionId: 'abc12345', project: 'caprock-web',
  severity: 'medium', title: 'Waiting for you', detail: '', since: NOW - 2 * 3600_000, ...over,
})

afterEach(() => { location.hash = '' })

describe('Waiting for you row', () => {
  it('names the session after the project', () => {
    render(<Attention items={[item()]} now={NOW} sessions={[session()]} />)
    expect(screen.getByText('caprock-web')).toBeTruthy()
    expect(screen.getByText('Fix the pricing page')).toBeTruthy()
  })

  it('in the app, a click anywhere on the row, Enter, and the button open its tab', () => {
    const onOpenSession = vi.fn()
    const { container } = render(
      <PipelineHostContext.Provider value={{ onOpenSession }}>
        <Attention items={[item()]} now={NOW} sessions={[session()]} />
      </PipelineHostContext.Provider>,
    )
    fireEvent.click(screen.getByText('Waiting for you'))
    expect(onOpenSession).toHaveBeenCalledWith('abc12345')
    const row = container.querySelector('[data-attention]') as HTMLElement
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onOpenSession).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: /Open terminal/ }))
    expect(onOpenSession).toHaveBeenCalledTimes(3)
  })

  it('"what did it ask?" opens the answer in place and does not jump', async () => {
    const onOpenSession = vi.fn()
    notes.calls = 0
    render(
      <PipelineHostContext.Provider value={{ onOpenSession }}>
        <Attention items={[item()]} now={NOW} sessions={[session()]} />
      </PipelineHostContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'what did it ask?' }))
    expect(onOpenSession).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(notes.calls).toBeGreaterThan(0))
    expect(location.hash).toBe('')
  })

  it('in a browser, goes to the terminal of a session Caprock holds', () => {
    render(<Attention items={[item()]} now={NOW} sessions={[session()]} />)
    fireEvent.click(screen.getByRole('button', { name: /Open terminal/ }))
    expect(location.hash).toBe('#/session/abc12345?tab=terminal')
  })

  it('in a browser, a session another terminal holds opens its page, said as such', () => {
    render(<Attention items={[item()]} now={NOW} sessions={[session({ owned: false })]} />)
    fireEvent.click(screen.getByRole('button', { name: /Open session/ }))
    expect(location.hash).toMatch(/^#\/session\/abc12345\?tab=timeline/)
  })

  it('other rows keep their small "open" link and are not a jump', () => {
    const { container } = render(<Attention items={[item({ id: 'error-abc12345', title: 'Hit an error', severity: 'high', detail: 'boom' })]} now={NOW} sessions={[session()]} />)
    expect(screen.getByText('open')).toBeTruthy()
    expect(container.querySelector('[role="link"]')).toBeNull()
  })
})
