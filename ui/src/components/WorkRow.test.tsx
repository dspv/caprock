import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionCIStats } from '@/lib/api'
import { buildWork, type WorkItem } from '@/lib/work'
import { NOW, statsFixture, workFixture } from '@/lib/work.fixture'
import { StageBar, WorkRow } from './WorkRow'

const items = () => buildWork(workFixture(), new Map<string, SessionCIStats | undefined>([['/w/caprock', statsFixture()]]), NOW).items
const pick = (n: number) => items().find((it) => it.pr?.number === n)!
const flow = statsFixture().board!.flow

function one(it: WorkItem, p: Partial<Parameters<typeof WorkRow>[0]> = {}) {
  render(<ul><WorkRow it={it} now={NOW} passed={0} flow={flow} {...p} /></ul>)
  return document.querySelector('[data-work-row]') as HTMLElement
}

describe('the stage bar', () => {
  it('fills the steps up to the stage, its label saying which', () => {
    render(<StageBar it={{ fill: 4, red: false, running: false, word: 'merged' }} />)
    const bar = screen.getByRole('img')
    expect(bar).toHaveAccessibleName('Step 4 of 5 (merged): merged')
    expect(bar.querySelectorAll('[data-on]')).toHaveLength(4)
  })

  it('draws the current step red when CI failed, and says when nothing has started', () => {
    const { rerender } = render(<StageBar it={{ fill: 3, red: true, running: false, word: 'CI red' }} />)
    expect(screen.getByRole('img').querySelector('[data-work-step="CI"]')!.className).toContain('bg-danger')
    rerender(<StageBar it={{ fill: 0, red: false, running: false, word: 'planned' }} />)
    expect(screen.getByRole('img')).toHaveAccessibleName('Not started: planned')
  })
})

describe('a Work row', () => {
  it('says merge → release with its basis on a merged one, and nothing invented on a ready one', () => {
    const merged = one(pick(630))
    expect(within(merged).getByText('usually released in ~2h').closest('[data-work-note]')).toHaveAttribute('title', expect.stringContaining('last 7 merged'))
    document.body.innerHTML = ''
    const ready = one(pick(633))
    expect(ready.querySelectorAll('[data-work-note]')).toHaveLength(0)
  })

  it('marks a row that needs you and says why', () => {
    const r = one(items().find((it) => it.key === 's:s2')!)
    expect(r).toHaveAttribute('data-needs-you', 'true')
    expect(r).toHaveTextContent('waiting for your approval')
  })

  it('opens the session named on it through the app', () => {
    const open = vi.fn()
    const r = one(pick(631), { onOpenSession: open })
    fireEvent.click(within(r).getByRole('button', { name: /Claude Code Opus 4.1/ }))
    expect(open).toHaveBeenCalledWith('s1')
  })

  it('links the session to its page in a browser', () => {
    const r = one(pick(631))
    expect(within(r).getByText(/Claude Code Opus 4.1/).closest('a')).toHaveAttribute('href', '#/session/s1')
  })
})
