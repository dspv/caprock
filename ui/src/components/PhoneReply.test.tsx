import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const brain = vi.hoisted(() => ({ drop: vi.fn(async () => ({ ok: true as const, node: 1 })) }))
vi.mock('@/lib/brain', () => ({ dropIntoBrain: brain.drop }))

import { HOLD_MS, PhoneReply } from './PhoneReply'
import { codeBlocksOf, parseDoc } from './Prose'

const REPLY = [
  '## Summary',
  '',
  '1. **Retry** with backoff',
  '2. *Timeouts* and ~~sleep~~',
  '',
  '```go',
  'func main() {}',
  '```',
  '',
  '| Test | Before | After |',
  '| --- | --- | --- |',
  '| A | FAIL | PASS |',
  '',
  'Run it with:',
  '',
  '    go test ./...',
].join('\n')

describe('PhoneReply — a reply as Markdown', () => {
  afterEach(cleanup)

  it('draws code as a block with Copy, lists as items, a table with its header', () => {
    const { container } = render(<PhoneReply id={7} text={REPLY} />)
    expect(container.querySelector('h2')?.textContent).toBe('Summary')
    const pres = [...container.querySelectorAll('pre')].map((p) => p.textContent)
    expect(pres).toEqual(['func main() {}', 'go test ./...'])
    expect(screen.getAllByRole('button', { name: 'Copy the code' })).toHaveLength(2)
    expect(container.querySelector('th')?.textContent).toBe('Test')
    expect(container.querySelector('em')?.textContent).toBe('Timeouts')
    expect(container.querySelector('s')?.textContent).toBe('sleep')
    expect(container.querySelector('strong')?.textContent).toBe('Retry')
    // No invisible button under the reply any more.
    expect(container.querySelector('[data-brain-drop]')).toBeNull()
  })

  it('a .md path in it opens the file', () => {
    const onPath = vi.fn()
    render(<PhoneReply id={7} text="See `docs/PLAN.md` for the plan." onPath={onPath} />)
    fireEvent.click(screen.getByRole('button', { name: 'docs/PLAN.md' }))
    expect(onPath).toHaveBeenCalledWith('docs/PLAN.md')
  })
})

describe('PhoneReply — the hold menu', () => {
  const writes: string[] = []
  beforeEach(() => {
    writes.length = 0
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async (t: string) => { writes.push(t) } } })
    localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const hold = (el: Element, ms = HOLD_MS) => {
    fireEvent.touchStart(el, { touches: [{ clientX: 10, clientY: 10 }] })
    act(() => { vi.advanceTimersByTime(ms) })
  }

  it('a finger held still opens Copy text, Copy code for each block, and 2nd Brain', async () => {
    vi.useFakeTimers()
    const { container } = render(<PhoneReply id={7} text={REPLY} />)
    const reply = container.querySelector('[data-phone-reply]')!
    hold(reply)
    fireEvent.touchEnd(reply)
    const menu = screen.getByRole('menu', { name: 'Reply' })
    expect([...menu.querySelectorAll('[role=menuitem]')].map((b) => b.textContent)).toEqual(['Copy text', 'Copy code 1go', 'Copy code 2go test ./...', 'Drop into 2nd Brain'])
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /Copy code 2/ })) })
    expect(writes).toEqual(['go test ./...'])
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Copy text' })) })
    expect(writes[1]).toBe(REPLY)
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Drop into 2nd Brain' })) })
    expect(brain.drop).toHaveBeenCalledWith({ event_id: 7 })
    expect(screen.getByRole('menuitem', { name: 'In 2nd Brain' })).toBeTruthy()
  })

  it('a finger that moves is scrolling, not holding', () => {
    vi.useFakeTimers()
    const { container } = render(<PhoneReply id={7} text="Plain words." />)
    const reply = container.querySelector('[data-phone-reply]')!
    fireEvent.touchStart(reply, { touches: [{ clientX: 10, clientY: 10 }] })
    fireEvent.touchMove(reply, { touches: [{ clientX: 10, clientY: 40 }] })
    act(() => { vi.advanceTimersByTime(HOLD_MS * 2) })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('a right click opens it too; one code block is "Copy code"; a paired phone has no 2nd Brain', () => {
    localStorage.setItem('caprock.device.token', 'tok')
    const { container } = render(<PhoneReply id={7} text={'```\nx\n```'} />)
    fireEvent.contextMenu(container.querySelector('[data-phone-reply]')!)
    const items = [...screen.getByRole('menu').querySelectorAll('[role=menuitem]')].map((b) => b.textContent)
    expect(items).toEqual(['Copy text', 'Copy code'])
  })
})

describe('parseDoc — what a reply needs beyond a document', () => {
  it('struck words and indented code, only for a reply', () => {
    const src = 'a ~~b~~ c\n\n    code line\n      more\n\nafter'
    expect(parseDoc(src).map((b) => b.kind)).toEqual(['para', 'para', 'para'])
    const reply = parseDoc(src, { reply: true })
    expect(reply.map((b) => b.kind)).toEqual(['para', 'code', 'para'])
    expect(reply[1]).toEqual({ kind: 'code', lang: '', text: 'code line\n  more' })
    expect(reply[0]).toMatchObject({ parts: [{ text: 'a ' }, { text: 'b', strike: true }, { text: ' c' }] })
  })

  it('text indented under a list item stays the item\'s, as CommonMark reads it', () => {
    const blocks = parseDoc('- one\n\n    still one\n\n  - nested', { reply: true })
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'para', 'item'])
    expect(codeBlocksOf('- one\n\n    still one')).toEqual([])
  })
})
