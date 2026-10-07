/**
 * The pill is the reload the page did not do by itself: a sheet held typed
 * text when the daemon was updated under it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RELOADED_KEY, resetStaleUi, watchUiVersion } from '@/lib/staleui'
import { StaleUiPill } from './StaleUiPill'

afterEach(() => { resetStaleUi(); sessionStorage.clear(); document.body.innerHTML = ''; document.head.innerHTML = '' })

describe('the stale UI pill', () => {
  it('is absent while the page matches its daemon', () => {
    render(<StaleUiPill />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('appears when a reload was held back, and reloads on a click', async () => {
    const meta = document.createElement('meta')
    meta.name = 'caprock-version'
    meta.content = '0.78.1'
    document.head.append(meta)
    const sheet = document.createElement('div')
    sheet.setAttribute('role', 'dialog')
    sheet.innerHTML = '<textarea>typed</textarea>'
    document.body.append(sheet)
    const reload = vi.fn()
    const stop = watchUiVersion({
      status: async () => ({ version: '0.78.2' }), subscribe: () => () => {}, isOpen: () => false, reload, doc: document,
    })
    render(<StaleUiPill />)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(reload).not.toHaveBeenCalled()
    const pill = screen.getByRole('button', { name: 'Reload — Caprock was updated' })
    // jsdom does not navigate; the click records the loop guard, then reloads.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    fireEvent.click(pill)
    quiet.mockRestore()
    expect(sessionStorage.getItem(RELOADED_KEY)).toBe('0.78.2')
    stop()
  })
})
