import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoopAlert } from '@/lib/api'

const h = vi.hoisted(() => ({ sent: [] as [string, string][], answer: { sent: false } as { sent: boolean } | Error }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      queueSend: async (id: string, text: string) => {
        h.sent.push([id, text])
        if (h.answer instanceof Error) throw h.answer
        return { ...h.answer, queue: { session_id: id, messages: [], waiting: 'turn' } }
      },
    },
  }
})

import { LoopAlertCard } from './LoopAlertCard'
import { loopHidden, resetLoopMutesForTest, tellAgentMessage } from '@/lib/loopalert'

const now = Date.parse('2026-10-14T11:00:00Z')
const a: LoopAlert = {
  kind: 'loop', session_id: 's1', tool: 'Bash', count: 5, window_min: 3,
  sample: 'Bash: python3 /private/tmp/claude-501/x/scratchpad/brain/p2e.py',
  first_ts: new Date(now - 300_000).toISOString(), last_ts: new Date(now - 150_000).toISOString(), ts: new Date(now - 150_000).toISOString(),
  tax_usd: 0.88,
}

beforeEach(() => { h.sent = []; h.answer = { sent: false }; localStorage.clear(); resetLoopMutesForTest() })

describe('LoopAlertCard', () => {
  it('says what happened, full command on hover, costs quiet', () => {
    render(<LoopAlertCard alert={a} project="caprock" owned sessionCostUSD={1886.75} now={now} openHref="#/session/s1" />)
    const card = screen.getByRole('alert')
    expect(card).toHaveTextContent('caprock ran the same command 5 times in 3 minutes')
    expect(screen.getByText('(python3 …/p2e.py)')).toHaveAttribute('title', 'python3 /private/tmp/claude-501/x/scratchpad/brain/p2e.py')
    expect(card).toHaveTextContent('$0.88 re-reading context')
    expect(card).toHaveTextContent('session total $1,886.75')
    // The two cap links are gone from the card's face.
    expect(card).not.toHaveTextContent(/\bcap\b/i)
  })

  it('on a session Caprock started: Tell the agent, Open session, Dismiss — in that order', () => {
    render(<LoopAlertCard alert={a} project="caprock" owned now={now} openHref="#/session/s1" />)
    const labels = Array.from(screen.getByRole('alert').querySelectorAll('button, a')).map((e) => e.textContent?.trim())
    expect(labels.slice(0, 3)).toEqual(['Tell the agent', 'Open session', 'Dismiss'])
  })

  // Rule 7: Caprock never types into a process it did not start.
  it('on a session Caprock did not start: no Tell the agent, Open session says why', () => {
    render(<LoopAlertCard alert={a} project="caprock" owned={false} now={now} openHref="#/session/s1" />)
    expect(screen.queryByRole('button', { name: 'Tell the agent' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Open session' }).getAttribute('title')).toMatch(/didn't start this session/)
  })

  it('treats unknown ownership as not owned', () => {
    render(<LoopAlertCard alert={a} project="caprock" now={now} openHref="#/session/s1" />)
    expect(screen.queryByRole('button', { name: 'Tell the agent' })).toBeNull()
  })

  it('inside the session, a card it cannot act on says why', () => {
    render(<LoopAlertCard alert={a} project="" owned={false} now={now} />)
    expect(screen.queryByRole('link', { name: 'Open session' })).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent(/never types into it/)
  })

  it('shows the message first, then queues it into that session', async () => {
    render(<LoopAlertCard alert={a} project="caprock" owned now={now} openHref="#/session/s1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Tell the agent' }))
    const box = screen.getByRole('textbox', { name: 'Message to the agent' }) as HTMLTextAreaElement
    expect(box.value).toBe(tellAgentMessage(a))
    expect(h.sent).toHaveLength(0)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to the agent' })) })
    expect(h.sent).toEqual([['s1', tellAgentMessage(a)]])
    expect(screen.getByRole('status')).toHaveTextContent('Queued — the agent gets it when this turn ends.')
  })

  it('sends what was edited', async () => {
    h.answer = { sent: true }
    render(<LoopAlertCard alert={a} project="caprock" owned now={now} openHref="#/session/s1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Tell the agent' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to the agent' }), { target: { value: '[Caprock] try the cache' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to the agent' })) })
    expect(h.sent).toEqual([['s1', '[Caprock] try the cache']])
    expect(screen.getByRole('status')).toHaveTextContent('Sent — the agent has it.')
  })

  it('says when the queue refused it', async () => {
    h.answer = new Error('409 Conflict')
    render(<LoopAlertCard alert={a} project="caprock" owned now={now} openHref="#/session/s1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Tell the agent' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to the agent' })) })
    expect(screen.getByRole('status')).toHaveTextContent('Not sent: 409 Conflict')
  })

  it('dismiss puts it away and tells the caller', () => {
    const onDismiss = vi.fn()
    render(<LoopAlertCard alert={a} project="caprock" owned now={now} openHref="#/session/s1" onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /^Dismiss$/ }))
    expect(onDismiss).toHaveBeenCalled()
    expect(loopHidden(a)).toBe(true)
  })

  it('the dismiss menu mutes this command and holds the one cap link', () => {
    render(<LoopAlertCard alert={a} project="caprock" owned now={now} openHref="#/session/s1" />)
    fireEvent.click(screen.getByRole('button', { name: 'More ways to dismiss' }))
    expect(screen.getAllByRole('menuitem', { name: /spending cap/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('menuitem', { name: "Don't warn about this command again in this session" }))
    expect(loopHidden({ ...a, ts: new Date(now).toISOString() })).toBe(true)
  })
})
