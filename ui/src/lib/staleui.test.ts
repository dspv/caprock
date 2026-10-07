/**
 * A page never stays older than its daemon: 0.78.2's app window ran 0.78.1's
 * UI for the rest of the run after the daemon was swapped under it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RELOADED_KEY, hasUnsavedInput, resetStaleUi, servedVersion, staleAction, watchUiVersion, type WatchDeps,
} from './staleui'

function page(meta?: string): Document {
  const doc = document.implementation.createHTMLDocument('t')
  if (meta !== undefined) {
    const m = doc.createElement('meta')
    m.name = 'caprock-version'
    m.content = meta
    doc.head.append(m)
  }
  return doc
}

describe('the policy', () => {
  it('does nothing while the page matches its daemon', () => {
    expect(staleAction({ served: '0.78.2', running: '0.78.2', unsaved: false })).toBe('none')
    expect(staleAction({ served: undefined, running: '0.78.2', unsaved: false })).toBe('none')
  })
  it('reloads onto a different daemon, newer or older', () => {
    expect(staleAction({ served: '0.78.1', running: '0.78.2', unsaved: false })).toBe('reload')
    expect(staleAction({ served: '0.78.2-dev+abc', running: '0.78.1', unsaved: false })).toBe('reload')
  })
  it('offers instead while a sheet holds typed text', () => {
    expect(staleAction({ served: '0.78.1', running: '0.78.2', unsaved: true })).toBe('offer')
  })
  it('never reloads twice for the same daemon', () => {
    expect(staleAction({ served: '0.78.1', running: '0.78.2', reloadedFor: '0.78.2', unsaved: false })).toBe('offer')
    expect(staleAction({ served: '0.78.1', running: '0.78.3', reloadedFor: '0.78.2', unsaved: false })).toBe('reload')
  })
})

describe('the page', () => {
  it('reads the version its daemon wrote into it', () => {
    expect(servedVersion(page('0.78.2'))).toBe('0.78.2')
    expect(servedVersion(page())).toBeUndefined()
    expect(servedVersion(page('  '))).toBeUndefined()
  })

  it('counts only typed text in an open modal sheet as unsaved', () => {
    const doc = page()
    doc.body.innerHTML = '<input id="filter" value="search me"><textarea class="xterm-helper-textarea">x</textarea>'
    expect(hasUnsavedInput(doc)).toBe(false)
    doc.body.innerHTML = '<div role="dialog" aria-modal="true"><input type="checkbox" checked><input value=" "></div>'
    expect(hasUnsavedInput(doc)).toBe(false)
    doc.body.innerHTML = '<div role="dialog" aria-modal="true"><textarea>a brief</textarea></div>'
    expect(hasUnsavedInput(doc)).toBe(true)
    doc.body.innerHTML = '<div hidden><div role="dialog"><input value="gone"></div></div>'
    expect(hasUnsavedInput(doc)).toBe(false)
  })
})

describe('the watcher', () => {
  let open = false
  let notify: () => void = () => {}
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const setOpen = (v: boolean) => { open = v; notify() }

  function watch(doc: Document, versions: string[], reload = vi.fn()) {
    const status = vi.fn(async () => ({ version: versions.shift() ?? 'none' }))
    const deps: Partial<WatchDeps> = {
      status,
      subscribe: (fn) => { notify = fn; return () => { notify = () => {} } },
      isOpen: () => open,
      reload,
      doc,
    }
    const stop = watchUiVersion(deps)
    return { status, reload, stop }
  }

  beforeEach(() => { open = false; sessionStorage.clear(); resetStaleUi() })
  afterEach(() => { sessionStorage.clear() })

  it('reloads once when the link comes back to a swapped daemon', async () => {
    // The app's 0.78.2 bug: served by 0.78.1, the daemon replaced two seconds later.
    const { status, reload, stop } = watch(page('0.78.1'), ['0.78.1', '0.78.2'])
    await flush()
    expect(reload).not.toHaveBeenCalled()
    setOpen(true)
    await flush()
    expect(status).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(RELOADED_KEY)).toBe('0.78.2')
    stop()
  })

  it('reloads at once when the daemon was swapped before the page first asked', async () => {
    const { reload, stop } = watch(page('0.78.1'), ['0.78.2'])
    await flush()
    expect(reload).toHaveBeenCalledTimes(1)
    stop()
  })

  it('asks only when the link opens again, not on every change', async () => {
    const { status, stop } = watch(page('0.78.2'), ['0.78.2', '0.78.2'])
    await flush()
    setOpen(true)
    notify()
    notify()
    await flush()
    expect(status).toHaveBeenCalledTimes(2)
    stop()
  })

  it('takes the first status as the served version on a page with no meta', async () => {
    const { reload, stop } = watch(page(), ['0.78.1', '0.78.2'])
    await flush()
    setOpen(true)
    await flush()
    expect(reload).toHaveBeenCalledTimes(1)
    stop()
  })

  it('does not loop on a daemon it already reloaded for', async () => {
    sessionStorage.setItem(RELOADED_KEY, '0.78.2')
    const { reload, stop } = watch(page('0.78.1'), ['0.78.2'])
    await flush()
    expect(reload).not.toHaveBeenCalled()
    stop()
  })

  it('clears the guard once the page matches its daemon', async () => {
    sessionStorage.setItem(RELOADED_KEY, '0.78.2')
    const { stop } = watch(page('0.78.2'), ['0.78.2'])
    await flush()
    expect(sessionStorage.getItem(RELOADED_KEY)).toBeNull()
    stop()
  })

  it('keeps a sheet with typed text and offers the reload instead', async () => {
    const doc = page('0.78.1')
    doc.body.innerHTML = '<div role="dialog" aria-modal="true"><textarea>half a prompt</textarea></div>'
    const { reload, stop } = watch(doc, ['0.78.2'])
    await flush()
    expect(reload).not.toHaveBeenCalled()
    stop()
  })

  it('keeps quiet while the daemon is away', async () => {
    const status = vi.fn(async () => { throw new Error('down') })
    const reload = vi.fn()
    const stop = watchUiVersion({ status, subscribe: () => () => {}, isOpen: () => false, reload, doc: page('0.78.1') })
    await flush()
    expect(reload).not.toHaveBeenCalled()
    stop()
  })
})
