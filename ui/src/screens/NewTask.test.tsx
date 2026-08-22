/**
 * Defect regression (panel finding 1, UI half): the form sent `[]` for an empty
 * criteria textarea, so the easiest task to create was one Caprock could not
 * verify — while the same screen promised "Nothing reaches Done until its
 * done_criteria pass". The form must not offer a path that produces an
 * unverifiable task.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NewTask } from './Tasks'
import { api } from '@/lib/api'

describe('NewTask', () => {
  it('refuses to create a task with no done criteria', () => {
    const createTask = vi.spyOn(api, 'createTask').mockResolvedValue({} as never)
    render(<NewTask onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/healthz/i), { target: { value: 'Do a thing' } })
    // Clear the criteria the form pre-fills, then try to submit.
    const criteria = screen.getByRole('textbox', { name: /done criteria/i })
    fireEvent.change(criteria, { target: { value: '   \n  \n' } })
    fireEvent.click(screen.getByRole('button', { name: /create task/i }))
    expect(createTask).not.toHaveBeenCalled()
    expect(screen.getByText(/done criterion is required/i)).toBeTruthy()
    createTask.mockRestore()
  })

  it('creates the task once a criterion is given', () => {
    const createTask = vi.spyOn(api, 'createTask').mockResolvedValue({} as never)
    render(<NewTask onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/healthz/i), { target: { value: 'Do a thing' } })
    fireEvent.change(screen.getByRole('textbox', { name: /done criteria/i }), { target: { value: 'go test ./...' } })
    fireEvent.click(screen.getByRole('button', { name: /create task/i }))
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ done_criteria: ['go test ./...'] }))
    createTask.mockRestore()
  })
})
