/**
 * Saving one setting must not carry the others with it.
 *
 * The hook used to PUT the whole Settings object, built from a module-level
 * cache, so any control could overwrite a field it knew nothing about with a
 * value it had read minutes earlier. Two tabs were enough to see it: change the
 * plan in one, click "check for updates" in the other, and the second wrote the
 * plan back to what its cache still held. Nothing failed to save — a stale copy
 * undid it, which is indistinguishable from "it does not stick".
 *
 * The server has always treated PUT as a patch. This pins that the client
 * behaves like one too.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UpdateBanner } from './UpdateBanner'
import type { Settings } from '@/lib/api'

const sent = vi.hoisted(() => ({ bodies: [] as Record<string, unknown>[] }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      update: async () => ({ enabled: true, current: 'v1', update_available: false }),
      saveSettings: async (s: Settings) => {
        sent.bodies.push(s as unknown as Record<string, unknown>)
        return s
      },
    },
  }
})

describe('saving one setting', () => {
  it('sends only the field that changed', async () => {
    sent.bodies = []
    const saves: Partial<Settings>[] = []
    const plan = {
      update_checks: false,
      plan_kind: 'flat',
      plan_label: 'Max 20×',
      plan_usd_per_month: 200,
    } as Settings

    render(<UpdateBanner plan={plan} onSave={(p) => saves.push(p)} now={Date.now()} />)
    fireEvent.click(await screen.findByText('check for updates'))

    await waitFor(() => expect(saves.length).toBe(1))
    // The whole point: turning on update checks must not also restate the
    // plan, because this component's copy of it may be minutes old.
    expect(saves[0]).toEqual({ update_checks: true })
    expect(saves[0]).not.toHaveProperty('plan_label')
    expect(saves[0]).not.toHaveProperty('plan_usd_per_month')
  })
})
