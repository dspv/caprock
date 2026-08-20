/**
 * The Answers surface exists because a session's conclusion was unreachable:
 * the timeline showed a 200-character slice on one line. These pin the parts
 * that would quietly undo that — collapsing a long summary with no way to open
 * it, or burying it under short mid-thought asides.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NoteCard } from './Notes'
import type { AssistantNote } from '@/lib/api'

const NOW = Date.parse('2026-08-20T12:00:00Z')

function note(over: Partial<AssistantNote> = {}): AssistantNote {
  return {
    event_id: 1,
    session_id: 'sess-abcdef12',
    project: 'caprock',
    ts: NOW - 60_000,
    model: 'claude-opus-5',
    text: 'Done. All tests green.',
    fragment: false,
    ...over,
  }
}

describe('NoteCard', () => {
  it('shows a short answer in full, with no expander', () => {
    render(<NoteCard note={note()} now={NOW} />)
    expect(screen.getByText('Done. All tests green.')).toBeTruthy()
    expect(screen.queryByText(/show all/)).toBeNull()
  })

  it('collapses a long answer but always offers the whole thing', () => {
    const long = 'Готово. '.repeat(300) // ~2400 characters, a real summary size
    render(<NoteCard note={note({ text: long })} now={NOW} />)
    const expander = screen.getByText(/show all/)
    expect(expander.textContent).toContain('2,400')
    fireEvent.click(expander)
    expect(screen.getByText(/show less/)).toBeTruthy()
  })

  it('counts characters, not bytes, when offering the full text', () => {
    // The bug that started all this counted bytes; Cyrillic would read double.
    const text = 'я'.repeat(1000)
    render(<NoteCard note={note({ text })} now={NOW} />)
    expect(screen.getByText(/show all 1,000 characters/)).toBeTruthy()
  })

  it('marks a mid-thought remark so it is not read as a conclusion', () => {
    render(<NoteCard note={note({ fragment: true, text: 'Let me check that.' })} now={NOW} />)
    expect(screen.getByText(/mid-thought/)).toBeTruthy()
  })

  it('names the session only when results span sessions', () => {
    const { rerender } = render(<NoteCard note={note()} now={NOW} />)
    expect(screen.queryByText('caprock')).toBeNull()
    rerender(<NoteCard note={note()} now={NOW} showSession />)
    expect(screen.getByText('caprock')).toBeTruthy()
  })

  it('preserves the newlines a summary depends on', () => {
    const text = 'What changed:\n\n- one\n- two'
    const { container } = render(<NoteCard note={note({ text })} now={NOW} />)
    const body = container.querySelector('.whitespace-pre-wrap')
    expect(body?.textContent).toBe(text)
  })
})
