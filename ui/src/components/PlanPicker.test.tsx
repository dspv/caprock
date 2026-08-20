/**
 * The plan menu writes the whole settings object, so it must carry unrelated
 * preferences through untouched. Setting a plan silently turning off release
 * checks would be a genuinely confusing bug — the user changed one thing and
 * two things changed.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PlanChip } from './PlanPicker'
import type { Settings } from '@/lib/api'

const enabled: Settings = {
  update_checks: true,
  plan_kind: 'flat',
  plan_label: 'Pro',
  plan_usd_per_month: 20,
}

describe('PlanChip', () => {
  it('keeps release checks on when the plan changes', () => {
    const onSave = vi.fn()
    render(<PlanChip plan={enabled} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: /Pro/ }))
    fireEvent.click(screen.getByText('Max 20×'))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ plan_kind: 'flat', plan_label: 'Max 20×', plan_usd_per_month: 200, update_checks: true }),
    )
  })

  it('prompts to set a plan when none is stated', () => {
    render(<PlanChip plan={{ update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0 }} onSave={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'set plan' })).toBeTruthy()
  })

  it('rejects a nonsense custom price instead of storing it', () => {
    const onSave = vi.fn()
    render(<PlanChip plan={enabled} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: /Pro/ }))
    fireEvent.change(screen.getByPlaceholderText('e.g. 150'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'set' }))
    expect(onSave).not.toHaveBeenCalled()
  })
})
