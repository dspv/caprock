/**
 * A private module on a paired phone (ADR-076 amended 2026-10-21): the bridge
 * forwards only the module's own files and store, with the device token; the
 * page is built with its scripts, styles and imports inlined; and the phone's
 * menu lists the module only while the phone is a controller.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MODULE_SCHEME, answerBridge, bridgePath, buildModulePage, moduleFiles, rewriteImports, type PageFiles } from './modulebridge'

const TOKEN_KEY = 'caprock.device.token'

describe('bridgePath: what a module page may ask for', () => {
  it('lets through the module’s own files, read only', () => {
    expect(bridgePath('alpha', 'GET', '/x/alpha/')).toBe('/x/alpha/')
    expect(bridgePath('alpha', 'GET', '/x/alpha/js/app.js')).toBe('/x/alpha/js/app.js')
    expect(bridgePath('alpha', 'get', '/x/alpha/img/a.png')).toBe('/x/alpha/img/a.png')
    expect(bridgePath('alpha', 'HEAD', '/x/alpha/seed/a.json')).toBe('/x/alpha/seed/a.json')
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(bridgePath('alpha', m, '/x/alpha/index.html')).toBeNull()
  })

  it('lets through the module’s own store, read and written', () => {
    expect(bridgePath('alpha', 'GET', '/v1/x/alpha/docs/notes')).toBe('/v1/x/alpha/docs/notes')
    expect(bridgePath('alpha', 'GET', '/v1/x/alpha/docs/notes?after=a&limit=100')).toBe('/v1/x/alpha/docs/notes?after=a&limit=100')
    for (const m of ['GET', 'PUT', 'PATCH', 'DELETE']) expect(bridgePath('alpha', m, '/v1/x/alpha/docs/notes/a')).toBe('/v1/x/alpha/docs/notes/a')
    expect(bridgePath('alpha', 'POST', '/v1/x/alpha/docs/notes')).toBeNull()
    expect(bridgePath('alpha', 'GET', '/v1/x/alpha/docs/')).toBeNull()
    expect(bridgePath('alpha', 'GET', '/v1/x/alpha/docs/notes/a/b')).toBeNull()
  })

  it('lets the module message the owner: its own Telegram and notify routes, POST only', () => {
    expect(bridgePath('alpha', 'POST', '/v1/x/alpha/telegram')).toBe('/v1/x/alpha/telegram')
    expect(bridgePath('alpha', 'post', '/v1/x/alpha/notify')).toBe('/v1/x/alpha/notify')
    expect(bridgePath('alpha', 'GET', '/v1/x/alpha/telegram')).toBeNull()
    expect(bridgePath('alpha', 'POST', '/v1/x/beta/notify')).toBeNull()
    expect(bridgePath('alpha', 'POST', '/v1/x/alpha/telegram?x=1')).toBeNull()
    expect(bridgePath('alpha', 'POST', '/v1/telegram/photo')).toBeNull()
  })

  it('refuses everything else: the API, another module, the key, climbing out, tricks', () => {
    for (const [m, p] of [
      ['POST', '/v1/agents'],
      ['GET', '/v1/sessions'],
      ['GET', '/v1/admin'],
      ['PUT', '/v1/admin'],
      ['GET', '/x/beta/'],
      ['PUT', '/v1/x/beta/docs/notes/a'],
      ['GET', '/x/alpha/../beta/index.html'],
      ['GET', '/x/alpha/./index.html'],
      ['GET', '/x/alpha//index.html'],
      ['GET', '/x/alpha/%2e%2e/beta/'],
      ['GET', '/x/alpha/..%2fbeta/'],
      ['GET', '/x/alpha/a%5cb'],
      ['PUT', '/v1/x/alpha/docs/%2e%2e/a'],
      ['GET', '//evil.example/x/alpha/'],
      ['GET', 'https://evil.example/x/alpha/'],
      ['GET', 'x/alpha/'],
      ['GET', '/x/alpha/a b'],
      ['GET', '/x/alpha/a\\b'],
      ['GET', '/x/alpha/#frag'],
      ['GET', '/x/alphabet/'],
      ['GET', '/v1/x/alpha/docsx/a'],
    ]) {
      expect(bridgePath('alpha', m!, p!), `${m} ${p}`).toBeNull()
    }
    // An id that is not a module id opens nothing.
    expect(bridgePath('../v1', 'GET', '/x/../v1/')).toBeNull()
    expect(bridgePath('', 'GET', '/x//')).toBeNull()
  })
})

describe('answerBridge: the dashboard’s side', () => {
  beforeEach(() => localStorage.setItem(TOKEN_KEY, 'dev-token'))
  afterEach(() => localStorage.clear())

  const req = (method: string, path: string, extra: Record<string, unknown> = {}) => ({ type: 'caprock:bridge', secret: 's3cret', id: 7, method, path, ...extra })

  it('ignores anything not signed with the frame’s secret', async () => {
    const f = vi.fn()
    expect(await answerBridge(req('GET', '/x/alpha/'), 'alpha', 'other', f)).toBeNull()
    expect(await answerBridge({ type: 'caprock:theme' }, 'alpha', 's3cret', f)).toBeNull()
    expect(await answerBridge(req('GET', '/x/alpha/'), 'alpha', '', f)).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it('answers 403 without sending a request for anything but the module’s own paths', async () => {
    const f = vi.fn()
    for (const [m, p] of [['POST', '/v1/agents'], ['GET', '/v1/x/beta/docs/a'], ['PUT', '/v1/admin'], ['GET', '/x/alpha/../beta/']]) {
      const r = await answerBridge(req(m!, p!), 'alpha', 's3cret', f)
      expect(r?.status, `${m} ${p}`).toBe(403)
      expect(r?.id).toBe(7)
    }
    expect(f).not.toHaveBeenCalled()
  })

  it('forwards the module’s own request with the device token, and only the headers it needs', async () => {
    const f = vi.fn(async () => new Response('{"id":"a"}', { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'x=1' } }))
    const body = new TextEncoder().encode('{"x":1}').buffer
    const r = await answerBridge(req('PUT', '/v1/x/alpha/docs/notes/a', { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t', 'X-Caprock-Device': 'forged' }, body }), 'alpha', 's3cret', f)
    expect(f).toHaveBeenCalledTimes(1)
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/v1/x/alpha/docs/notes/a')
    expect(init.method).toBe('PUT')
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'X-Caprock-Device': 'dev-token' })
    expect(init.body).toBe(body)
    expect(r?.status).toBe(200)
    expect(r?.headers).toEqual({ 'content-type': 'application/json' })
    expect(new TextDecoder().decode(r!.body!)).toBe('{"id":"a"}')
  })

  it('says JSON on a write that did not, as the daemon’s forgery guard wants', async () => {
    const f = vi.fn(async () => new Response('{"deleted":true}', { status: 200 }))
    await answerBridge(req('DELETE', '/v1/x/alpha/docs/notes/a'), 'alpha', 's3cret', f)
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(init.body).toBeUndefined()
  })

  it('turns a failed request into an error the page’s fetch rejects with', async () => {
    const r = await answerBridge(req('GET', '/x/alpha/a.js'), 'alpha', 's3cret', async () => { throw new TypeError('channel closed') })
    expect(r?.error).toBe('channel closed')
  })
})

describe('moduleFiles: the build reads only the module’s own files', () => {
  afterEach(() => localStorage.clear())
  it('refuses a path outside the module and sends the token with the rest', async () => {
    localStorage.setItem(TOKEN_KEY, 'dev-token')
    const f = vi.fn(async () => new Response('hi'))
    const files = moduleFiles('alpha', f)
    await expect(files.text('/v1/sessions')).rejects.toThrow()
    await expect(files.text('/x/beta/')).rejects.toThrow()
    expect(await files.text('/x/alpha/a.txt')).toBe('hi')
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0]).toEqual(['/x/alpha/a.txt', { headers: { 'X-Caprock-Device': 'dev-token' } }])
  })
})

describe('the page a phone runs', () => {
  it('rewrites relative imports to the module’s own URLs and leaves the rest', () => {
    const src = [
      'import { store } from "./store.js";',
      "import './side.js'",
      "export * from '../lib/x.js'",
      "const m = await import('./lazy.js')",
      "import React from 'react'",
      "import x from 'https://cdn.example/x.js'",
      "import y from '../../../outside.js'",
    ].join('\n')
    const { code, deps } = rewriteImports('alpha', src, '/x/alpha/js/app.js')
    expect(deps).toEqual(['/x/alpha/js/store.js', '/x/alpha/js/side.js', '/x/alpha/lib/x.js', '/x/alpha/js/lazy.js'])
    expect(code).toContain(`from "${MODULE_SCHEME}/x/alpha/js/store.js"`)
    expect(code).toContain(`import '${MODULE_SCHEME}/x/alpha/js/side.js'`)
    expect(code).toContain(`import('${MODULE_SCHEME}/x/alpha/js/lazy.js')`)
    expect(code).toContain("from 'react'")
    expect(code).toContain("from 'https://cdn.example/x.js'")
    expect(code).toContain("from '../../../outside.js'")
  })

  it('inlines styles and scripts, maps the imports, carries the theme, and boots first', async () => {
    const tree: Record<string, string> = {
      '/x/alpha/': '<!doctype html><html><head><base href="https://elsewhere.example/"><link rel="stylesheet" href="style.css"><link rel="icon" href="icon.png"></head><body><img src="img/a.png"><script type="module" src="app.js"></script><script src="https://cdn.example/lib.js"></script></body></html>',
      '/x/alpha/style.css': 'body{background:url(img/bg.png)} .x{background:url("https://cdn.example/p.png")}',
      '/x/alpha/app.js': 'import { store } from "./store.js"; store()',
      '/x/alpha/store.js': 'export const store = () => fetch("/v1/x/alpha/docs/notes")',
    }
    const asked: string[] = []
    const files: PageFiles = {
      text: async (p) => { asked.push(p); if (!(p in tree)) throw new Error(`no ${p}`); return tree[p]! },
      dataURL: async (p) => { asked.push(p); return `data:image/png;base64,${btoa(p)}` },
    }
    const page = await buildModulePage('alpha', files, { secret: 'abc', origin: 'https://m.example', theme: { theme: 'light', vars: { '--color-bg': '#fff' } } })
    const doc = new DOMParser().parseFromString(page, 'text/html')

    // Only the module's own files were read; the icon and the CDN were not.
    expect(asked.sort()).toEqual(['/x/alpha/', '/x/alpha/app.js', '/x/alpha/img/bg.png', '/x/alpha/store.js', '/x/alpha/style.css'])

    const head = doc.head.children
    expect(head[0]!.tagName).toBe('BASE')
    expect(head[0]!.getAttribute('href')).toBe(`${MODULE_SCHEME}/x/alpha/`)
    expect(head[1]!.getAttribute('type')).toBe('importmap')
    expect(head[2]!.textContent).toContain('"secret":"abc"')
    expect(head[2]!.textContent).toContain('"origin":"https://m.example"')
    expect(doc.querySelectorAll('base')).toHaveLength(1)
    expect(doc.querySelector('link[rel=icon]')).toBeNull()

    const map = JSON.parse(head[1]!.textContent!) as { imports: Record<string, string> }
    expect(Object.keys(map.imports).sort()).toEqual([`${MODULE_SCHEME}/x/alpha/app.js`, `${MODULE_SCHEME}/x/alpha/store.js`])
    const app = doc.querySelector('script[type=module]')!.getAttribute('src')!
    expect(app).toBe(map.imports[`${MODULE_SCHEME}/x/alpha/app.js`])
    expect(decodeURIComponent(app)).toContain(`from "${MODULE_SCHEME}/x/alpha/store.js"`)
    expect(doc.querySelector('script[src^="https://cdn.example"]')).not.toBeNull()

    const css = decodeURIComponent(doc.querySelector('link[rel=stylesheet]')!.getAttribute('href')!)
    expect(css).toContain(`url("data:image/png;base64,${btoa('/x/alpha/img/bg.png')}")`)
    expect(css).toContain('url("https://cdn.example/p.png")')

    expect(doc.documentElement.getAttribute('data-theme')).toBe('light')
    expect(doc.documentElement.style.getPropertyValue('--color-bg')).toBe('#fff')
    // The image is left for the bootstrap to fill through the bridge.
    expect(doc.querySelector('img')!.getAttribute('src')).toBe('img/a.png')
  })

  it('keeps "</script>" in a module from closing the import map', async () => {
    const files: PageFiles = {
      text: async (p) => (p === '/x/alpha/' ? '<script type="module" src="a.js"></script>' : 'const s = "</script><script>alert(1)</script>"'),
      dataURL: async () => '',
    }
    const page = await buildModulePage('alpha', files, { secret: 's', origin: 'o', theme: { theme: 'dark', vars: {} } })
    const doc = new DOMParser().parseFromString(page, 'text/html')
    expect(doc.querySelectorAll('script')).toHaveLength(3)
  })
})

describe('the phone’s menu', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    vi.resetModules()
  })

  async function menuFor(role: 'viewer' | 'controller') {
    localStorage.setItem(TOKEN_KEY, 'dev-token')
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      let out: unknown = {}
      if (url.startsWith('/v1/pair/me')) out = { role }
      if (url === '/v1/admin') out = { admin: true, modules: ['alpha'], installed: [{ id: 'alpha', name: 'Alpha', url: '/x/alpha/' }] }
      return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const { PhoneBar } = await import('@/components/PhoneBar')
    render(<PhoneBar link={{ phase: 'live', attempt: 0, nextAt: 0, offlineSince: 0 } as never} heardAt={() => Date.now()} />)
    return calls
  }

  it('lists the module on a controller', async () => {
    await menuFor('controller')
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: 'More' }))
      expect(screen.getByRole('menuitem', { name: /Alpha/ }).getAttribute('href')).toBe('#/x/alpha')
    })
  })

  it('never asks, and lists nothing, on a viewer', async () => {
    const calls = await menuFor('viewer')
    await waitFor(() => expect(calls.some((c) => c.startsWith('/v1/pair/me'))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.queryByRole('menuitem', { name: /Alpha/ })).toBeNull()
    expect(calls).not.toContain('/v1/admin')
  })
})
