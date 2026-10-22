import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal as Xterm, type IDecorationOptions } from '@xterm/xterm'
import {
  attachDevServerWatch, devServers, devUrlOf, devUrlsIn, forgetDevServers, MAX_SERVERS, noteDevServer,
  PHONE_PREVIEW_EVENT, PREVIEW_CELLS, PREVIEW_LABEL, requestPhonePreview, type PhonePreviewDetail,
} from './devservers'

const urls = (line: string) => devUrlsIn(line).map((h) => h.url)

describe('local dev-server addresses in terminal text', () => {
  // What the common dev servers print, as they print it.
  it.each([
    ['  ➜  Local:   http://localhost:5173/', 'http://localhost:5173/'],
    ['   - Local:        http://localhost:3000', 'http://localhost:3000/'],
    ['<i> [webpack-dev-server] Loopback: http://localhost:8080/, http://[::1]:8080/', 'http://localhost:8080/'],
    ['Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...', 'http://localhost:8000/'],
    ['Listening on http://127.0.0.1:4321', 'http://127.0.0.1:4321/'],
    ['  Local:   https://app.localhost:5173/admin?x=1', 'https://app.localhost:5173/admin?x=1'],
    ['ready on [::1]:3000', 'http://[::1]:3000/'],
    ['open localhost:4200 in a browser', 'http://localhost:4200/'],
    ['Network: use --host to expose; Local: http://localhost:5173/.', 'http://localhost:5173/'],
  ])('finds %j', (line, want) => {
    expect(urls(line)[0]).toBe(want)
  })

  it('finds each address on a line once, where it stands', () => {
    const hits = devUrlsIn('a http://localhost:8080/ and http://[::1]:8080/')
    expect(hits.map((h) => [h.text, h.start, h.end])).toEqual([
      ['http://localhost:8080/', 2, 24],
      ['http://[::1]:8080/', 29, 47],
    ])
  })

  it.each([
    'https://github.com/dspv/caprock',
    'Network: http://192.168.1.20:5173/',
    'http://example.com:3000/localhost:3000',
    '/Users/lena/localhost:3000/index.html',
    'see ./notes/localhost.md',
    'file:///Users/lena/site/index.html',
    'ftp://localhost:21/',
    'localhost alone, no port',
    'user@localhost:22',
    'http://localhostile.com:3000/',
    '',
  ])('takes nothing from %j', (line) => {
    expect(urls(line)).toEqual([])
  })

  it('opens a server bound to every address on this machine', () => {
    expect(devUrlOf('0.0.0.0:8000')).toBe('http://localhost:8000/')
    expect(devUrlOf('http://[::]:3000/')).toBe('http://localhost:3000/')
    expect(devUrlOf('https://example.com/')).toBeNull()
  })
})

describe('the servers seen', () => {
  beforeEach(() => forgetDevServers())

  it('lists them newest first, once per origin, with the session last seen in', () => {
    noteDevServer('http://localhost:5173/', 'shell-1', 1)
    noteDevServer('http://localhost:3000/', 'shell-2', 2)
    noteDevServer('http://localhost:5173/about', undefined, 3)
    expect(devServers()).toEqual([
      { url: 'http://localhost:5173/about', sessionId: 'shell-1', seen: 3 },
      { url: 'http://localhost:3000/', sessionId: 'shell-2', seen: 2 },
    ])
  })

  it('keeps the newest few', () => {
    for (let i = 0; i < MAX_SERVERS + 3; i++) noteDevServer(`http://localhost:${4000 + i}/`, undefined, i)
    expect(devServers()).toHaveLength(MAX_SERVERS)
    expect(devServers()[0]!.url).toBe(`http://localhost:${4000 + MAX_SERVERS + 2}/`)
  })

  it('asks the workspace for a preview through one event', () => {
    const got: PhonePreviewDetail[] = []
    const on = (e: Event) => got.push((e as CustomEvent<PhonePreviewDetail>).detail)
    window.addEventListener(PHONE_PREVIEW_EVENT, on)
    requestPhonePreview({ url: 'http://localhost:5173/', sessionId: 's1' })
    window.removeEventListener(PHONE_PREVIEW_EVENT, on)
    expect(got).toEqual([{ url: 'http://localhost:5173/', sessionId: 's1' }])
  })
})

describe('the action beside an address in a terminal', () => {
  let host: HTMLDivElement
  let term: Xterm
  beforeEach(() => {
    forgetDevServers()
    if (!window.matchMedia) {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
      })
    }
    host = document.createElement('div')
    document.body.append(host)
    term = new Xterm({ cols: 80, rows: 10, allowProposedApi: true })
    term.open(host)
  })
  afterEach(() => {
    term.dispose()
    host.remove()
  })

  const watch = async (text: string, withAction = true) => {
    const decos: { opts: IDecorationOptions; render: (el: HTMLElement) => void }[] = []
    const real = term.registerDecoration.bind(term)
    vi.spyOn(term, 'registerDecoration').mockImplementation((opts) => {
      const d = real(opts)
      const entry = { opts, render: (_el: HTMLElement) => {} }
      decos.push(entry)
      if (d) vi.spyOn(d, 'onRender').mockImplementation((cb) => { entry.render = cb; return { dispose() {} } })
      return d
    })
    const previewed: string[] = []
    const w = attachDevServerWatch(term, { sessionId: 'shell-1', ...(withAction ? { onPreview: (u: string) => previewed.push(u) } : {}) })
    await new Promise<void>((r) => term.write(text, r))
    await vi.waitFor(() => expect(devServers().length + decos.length).toBeGreaterThan(0), { timeout: 2000 }).catch(() => {})
    await new Promise((r) => setTimeout(r, 450))
    return { decos, previewed, w }
  }

  it('draws one action after a local address, and a click asks for its preview', async () => {
    const line = '  ➜  Local:   http://localhost:5173/'
    const { decos, previewed, w } = await watch(`VITE v6 ready\r\n\r\n${line}\r\n  ➜  Network: use --host\r\n`)
    expect(decos).toHaveLength(1)
    expect(decos[0]!.opts.x).toBe(line.length)
    expect(decos[0]!.opts.width).toBe(PREVIEW_CELLS)
    const el = document.createElement('div')
    decos[0]!.render(el)
    decos[0]!.render(el)
    const buttons = el.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent).toBe(PREVIEW_LABEL)
    buttons[0]!.click()
    expect(previewed).toEqual(['http://localhost:5173/'])
    expect(devServers()).toEqual([expect.objectContaining({ url: 'http://localhost:5173/', sessionId: 'shell-1' })])
    w.dispose()
  })

  it('draws nothing for a remote address or a path', async () => {
    const { decos, w } = await watch('deployed to https://lena.dev/\r\n/Users/lena/localhost:3000/a.html\r\n')
    expect(decos).toHaveLength(0)
    expect(devServers()).toEqual([])
    w.dispose()
  })

  it('remembers the server but draws no action where no page can show', async () => {
    const { decos, w } = await watch('Local: http://localhost:3000\r\n', false)
    expect(decos).toHaveLength(0)
    expect(devServers().map((s) => s.url)).toEqual(['http://localhost:3000/'])
    w.dispose()
  })

  it('draws no action on a row with no room left for it', async () => {
    const { decos, w } = await watch(`${'x'.repeat(50)} http://localhost:3000\r\n`)
    expect(decos).toHaveLength(0)
    expect(devServers()).toHaveLength(1)
    w.dispose()
  })
})
