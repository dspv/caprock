import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateInfo } from '@/lib/appupdate'

const h = vi.hoisted(() => ({ settings: { update_checks: false } as Record<string, unknown>, saved: [] as unknown[] }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      settings: async () => h.settings,
      saveSettings: async (s: unknown) => { h.saved.push(s); return s },
    },
  }
})

// Fresh modules per test: the settings cache (usePlan) and the updater
// store are module state.
async function load() {
  return (await import('./AppUpdateAsk')).AppUpdateAsk
}

let app: AppUpdateInfo
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  h.saved = []
  app = { version: '0.78.1', supported: true, asked: false, phase: 'idle' }
  invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'app_update_status') return app
    if (cmd === 'app_update_asked') { app = { ...app, asked: true }; return undefined }
    throw new Error(cmd)
  })
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke }
})
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('the first-launch question (F20)', () => {
  it('asks once in the app, Yes focused; Yes turns the release check on', async () => {
    h.settings = { update_checks: false }
    const AppUpdateAsk = await load()
    render(<AppUpdateAsk />)
    const yes = await screen.findByRole('button', { name: 'Yes' })
    expect(screen.getByRole('dialog', { name: 'Check for updates automatically?' })).toHaveTextContent('Nothing about you or your work is sent')
    expect(document.activeElement).toBe(yes)
    fireEvent.click(yes)
    await act(async () => { await Promise.resolve() })
    expect(h.saved).toContainEqual({ update_checks: true })
    expect(invoke).toHaveBeenCalledWith('app_update_asked', {})
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('No is remembered and turns nothing on', async () => {
    h.settings = { update_checks: false }
    const AppUpdateAsk = await load()
    render(<AppUpdateAsk />)
    fireEvent.click(await screen.findByRole('button', { name: 'No' }))
    await act(async () => { await Promise.resolve() })
    expect(h.saved).toEqual([])
    expect(invoke).toHaveBeenCalledWith('app_update_asked', {})
  })

  it('is not asked when checks are already on, and is marked answered', async () => {
    h.settings = { update_checks: true }
    const AppUpdateAsk = await load()
    render(<AppUpdateAsk />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app_update_asked', {}))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('is not asked again once answered', async () => {
    app = { ...app, asked: true }
    const AppUpdateAsk = await load()
    render(<AppUpdateAsk />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
