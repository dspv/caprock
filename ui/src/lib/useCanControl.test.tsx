import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { api, clearDeviceToken, setDeviceToken } from './api'

function Probe({ useHook }: { useHook: () => boolean }) {
  return <span>{useHook() ? 'can control' : 'view only'}</span>
}

// The module keeps the role it last heard, so each case loads it fresh.
async function freshHook() {
  vi.resetModules()
  return (await import('./useCanControl')).useCanControl
}

describe('useCanControl', () => {
  afterEach(() => {
    cleanup()
    clearDeviceToken()
    vi.restoreAllMocks()
  })

  it('is always true on the machine itself, without asking', async () => {
    const me = vi.spyOn(api, 'pairMe')
    render(<Probe useHook={await freshHook()} />)
    expect(screen.getByText('can control')).toBeTruthy()
    expect(me).not.toHaveBeenCalled()
  })

  it('is false on a paired phone until the daemon says it is a controller', async () => {
    setDeviceToken('tok')
    const useHook = await freshHook()
    const { api: freshApi } = await import('./api')
    vi.spyOn(freshApi, 'pairMe').mockResolvedValue({ role: 'controller', id: 'a', name: 'iPhone' })
    render(<Probe useHook={useHook} />)
    expect(screen.getByText('view only')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('can control')).toBeTruthy())
  })

  it('stays false for a viewer', async () => {
    setDeviceToken('tok')
    const useHook = await freshHook()
    const { api: freshApi } = await import('./api')
    const me = vi.spyOn(freshApi, 'pairMe').mockResolvedValue({ role: 'viewer', id: 'a', name: 'iPhone' })
    render(<Probe useHook={useHook} />)
    await waitFor(() => expect(me).toHaveBeenCalled())
    expect(screen.getByText('view only')).toBeTruthy()
  })
})
