import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal as Xterm, type ILink, type ILinkProvider } from '@xterm/xterm'

const h = vi.hoisted(() => ({ tauri: false, opened: [] as string[], reject: false }))
vi.mock('./appmode', () => ({ isTauri: () => h.tauri, isMacPlatform: () => true }))
vi.mock('./shell', () => ({
  shell: {
    openExternal: (url: string) => {
      h.opened.push(`shell:${url}`)
      return h.reject ? Promise.reject(new Error('refused')) : Promise.resolve()
    },
  },
}))

import { attachTerminalLinks, choosesBrowser, linkHint, openableUrl, openLink, opensLink } from './termlinks'

const click = (mods: Partial<MouseEvent> = {}) =>
  ({ metaKey: false, ctrlKey: false, preventDefault: vi.fn(), clientX: 10, clientY: 10, ...mods }) as unknown as MouseEvent

afterEach(() => {
  h.tauri = false
  h.reject = false
  h.opened = []
  vi.restoreAllMocks()
})

describe('openableUrl', () => {
  it('takes http, https and mailto', () => {
    expect(openableUrl('https://github.com/dspv/caprock/pull/1')).toBe('https://github.com/dspv/caprock/pull/1')
    expect(openableUrl('http://127.0.0.1:22776/')).toBe('http://127.0.0.1:22776/')
    expect(openableUrl('mailto:who@example.com')).toBe('mailto:who@example.com')
    expect(openableUrl('  HTTPS://Example.com/a  ')).toBe('https://example.com/a')
  })

  it('refuses every other scheme and anything that is not a URL', () => {
    for (const raw of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>1</script>',
      'vscode://file/x',
      'ssh://host',
      'tel:123',
      'src/foo.ts:12',
      'example.com',
      'http://',
      '',
    ]) {
      expect(openableUrl(raw), raw).toBeNull()
    }
  })
})

describe('opensLink', () => {
  it('is Cmd on macOS and Ctrl elsewhere; a plain click never opens', () => {
    expect(opensLink({ metaKey: true, ctrlKey: false }, true)).toBe(true)
    expect(opensLink({ metaKey: false, ctrlKey: true }, true)).toBe(false)
    expect(opensLink({ metaKey: false, ctrlKey: false }, true)).toBe(false)
    expect(opensLink({ metaKey: true, ctrlKey: true }, true)).toBe(false)
    expect(opensLink({ metaKey: false, ctrlKey: true }, false)).toBe(true)
    expect(opensLink({ metaKey: true, ctrlKey: false }, false)).toBe(false)
    expect(opensLink({ metaKey: false, ctrlKey: false }, false)).toBe(false)
  })

  it('hints the platform key', () => {
    expect(linkHint(true)).toBe('⌘-click to open')
    expect(linkHint(false)).toBe('Ctrl+click to open')
    expect(linkHint(true, true)).toBe('⌘-click to open · ⇧⌘-click to choose a browser')
    expect(linkHint(false, true)).toBe('Ctrl+click to open · Ctrl+Shift+click to choose a browser')
  })
})

describe('choosesBrowser', () => {
  const m = (mods: Partial<MouseEvent>) => ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods })
  it('is ⇧⌘ on macOS and Ctrl+Shift elsewhere, and only then', () => {
    expect(choosesBrowser(m({ metaKey: true, shiftKey: true }), true)).toBe(true)
    expect(choosesBrowser(m({ metaKey: true }), true)).toBe(false)
    expect(choosesBrowser(m({ ctrlKey: true, shiftKey: true }), true)).toBe(false)
    expect(choosesBrowser(m({ metaKey: true, shiftKey: true, altKey: true }), true)).toBe(false)
    expect(choosesBrowser(m({ ctrlKey: true, shiftKey: true }), false)).toBe(true)
    expect(choosesBrowser(m({ ctrlKey: true }), false)).toBe(false)
    expect(choosesBrowser(m({ shiftKey: true }), false)).toBe(false)
    expect(choosesBrowser(m({ metaKey: true, shiftKey: true }), false)).toBe(false)
  })
})

describe('openLink', () => {
  it('opens a new tab in a browser, without an opener', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    openLink('https://example.com/')
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener')
    expect(h.opened).toEqual([])
  })

  it('goes through the shell in the desktop app', async () => {
    h.tauri = true
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    openLink('https://example.com/')
    await Promise.resolve()
    expect(h.opened).toEqual(['shell:https://example.com/'])
    expect(open).not.toHaveBeenCalled()
  })

  it('falls back to window.open when the shell refuses', async () => {
    h.tauri = true
    h.reject = true
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    openLink('mailto:who@example.com')
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('mailto:who@example.com', '_blank', 'noopener'))
  })

  it('opens nothing for a scheme it does not take', () => {
    h.tauri = true
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    openLink('file:///etc/passwd')
    expect(open).not.toHaveBeenCalled()
    expect(h.opened).toEqual([])
  })
})

// A real xterm, fed real bytes: the addon finds the plain URL, the OSC 8
// sequence becomes a link through the terminal's own provider, and both go
// through the same modifier and scheme checks.
describe('attachTerminalLinks', () => {
  const setup = async (text: string, onPath?: (p: string) => void) => {
    // jsdom has no matchMedia; xterm asks it for the device pixel ratio.
    if (!window.matchMedia) {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
      })
    }
    const providers: ILinkProvider[] = []
    const host = document.createElement('div')
    document.body.append(host)
    const term = new Xterm({ cols: 120, rows: 10, allowProposedApi: true })
    const register = term.registerLinkProvider.bind(term)
    vi.spyOn(term, 'registerLinkProvider').mockImplementation((p) => {
      providers.push(p)
      return register(p)
    })
    term.open(host)
    const opened: string[] = []
    const chosen: string[] = []
    const links = attachTerminalLinks(term, { mac: true, open: (u) => opened.push(u), choose: (u, at) => chosen.push(`${u} @${at.x},${at.y}`), onPath })
    await new Promise<void>((r) => term.write(text, r))
    const linksOn = (y: number, n = 0) =>
      new Promise<ILink[]>((r) => providers[n]!.provideLinks(y, (l) => r(l ?? [])))
    const teardown = () => {
      links.dispose()
      term.dispose()
      host.remove()
    }
    return { term, host, links, opened, chosen, linksOn, teardown }
  }

  it('opens a plain URL on Cmd+click only', async () => {
    const t = await setup('build done: https://github.com/dspv/caprock/actions/runs/1 (3m)\r\n')
    const link = (await t.linksOn(1))[0]!
    expect(link.text).toBe('https://github.com/dspv/caprock/actions/runs/1')
    link.activate(click(), link.text)
    expect(t.opened).toEqual([])
    link.activate(click({ ctrlKey: true }), link.text)
    expect(t.opened).toEqual([])
    link.activate(click({ metaKey: true }), link.text)
    expect(t.opened).toEqual(['https://github.com/dspv/caprock/actions/runs/1'])
    expect(t.chosen).toEqual([])
    t.teardown()
  })

  // Owner, 2026-10-17: ⌘-click stays the default browser; another chord
  // shows the browsers to choose from.
  it('opens the chooser at the pointer on ⇧⌘-click, and only for a web link', async () => {
    const t = await setup('see https://example.com/a and mailto:who@example.com\r\n')
    const link = (await t.linksOn(1))[0]!
    const e = click({ metaKey: true, shiftKey: true, clientX: 40, clientY: 70 })
    link.activate(e, link.text)
    expect(t.chosen).toEqual(['https://example.com/a @40,70'])
    expect(t.opened).toEqual([])
    expect(e.preventDefault).toHaveBeenCalled()
    // With ⌥ as well it is no chooser: ⌘ still opens it, as before.
    link.activate(click({ metaKey: true, shiftKey: true, altKey: true }), link.text)
    expect(t.chosen).toHaveLength(1)
    expect(t.opened).toEqual(['https://example.com/a'])
    // A mailto link has no browser to choose: the chord opens it as ⌘-click does.
    t.term.options.linkHandler!.activate(click({ metaKey: true, shiftKey: true }), 'mailto:who@example.com', { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } })
    expect(t.opened).toEqual(['https://example.com/a', 'mailto:who@example.com'])
    expect(t.chosen).toHaveLength(1)
    t.teardown()
  })

  it('opens a .md path an agent printed in a tab, on Cmd+click only', async () => {
    const paths: string[] = []
    const t = await setup('⏺ Wrote docs/PLAN.md and @/Users/me/app/NOTES.md:4\r\n', (p) => paths.push(p))
    const links = await t.linksOn(1, 1)
    expect(links.map((l) => l.text)).toEqual(['docs/PLAN.md', '/Users/me/app/NOTES.md'])
    links[0]!.activate(click(), links[0]!.text)
    expect(paths).toEqual([])
    links[1]!.activate(click({ metaKey: true }), links[1]!.text)
    expect(paths).toEqual(['/Users/me/app/NOTES.md'])
    expect(t.opened).toEqual([])
    t.teardown()
  })

  it('shows the hint on hover and takes it away on leave', async () => {
    const t = await setup('see https://example.com/a\r\n')
    const link = (await t.linksOn(1))[0]!
    link.hover?.(click(), link.text)
    const tip = t.host.querySelector('.caprock-link-tip')
    expect(tip?.textContent).toBe('⌘-click to open · ⇧⌘-click to choose a browser')
    expect(tip?.classList.contains('xterm-hover')).toBe(true)
    link.leave?.(click(), link.text)
    expect(t.host.querySelector('.caprock-link-tip')).toBeNull()
    t.teardown()
  })

  it('opens an OSC 8 hyperlink through the linkHandler, and names its address', async () => {
    const t = await setup('PR: \x1b]8;;https://github.com/dspv/caprock/pull/330\x07#330\x1b]8;;\x07 opened\r\n')
    const handler = t.term.options.linkHandler
    expect(handler?.allowNonHttpProtocols).toBe(true)
    // The terminal's own OSC provider reads the handler; reach it as xterm does.
    const core = (t.term as unknown as { _core: { _linkProviderService: { linkProviders: ILinkProvider[] } } })._core
    const osc = core._linkProviderService.linkProviders[0]!
    const found = await new Promise<ILink[]>((r) => osc.provideLinks(1, (l) => r(l ?? [])))
    expect(found.map((l) => l.text)).toEqual(['https://github.com/dspv/caprock/pull/330'])
    const link = found[0]!
    link.hover?.(click(), link.text)
    expect(t.host.querySelector('.caprock-link-tip')?.textContent).toBe(
      '⌘-click to open · ⇧⌘-click to choose a browser · https://github.com/dspv/caprock/pull/330',
    )
    link.activate(click(), link.text)
    expect(t.opened).toEqual([])
    link.activate(click({ metaKey: true }), link.text)
    expect(t.opened).toEqual(['https://github.com/dspv/caprock/pull/330'])
    t.teardown()
  })

  it('ignores an OSC 8 link with a scheme it does not open', async () => {
    const t = await setup('\x1b]8;;file:///etc/passwd\x07passwd\x1b]8;;\x07 \x1b]8;;javascript:alert(1)\x07x\x1b]8;;\x07\r\n')
    const handler = t.term.options.linkHandler!
    handler.activate(click({ metaKey: true }), 'file:///etc/passwd', { start: { x: 1, y: 1 }, end: { x: 6, y: 1 } })
    handler.activate(click({ metaKey: true }), 'javascript:alert(1)', { start: { x: 8, y: 1 }, end: { x: 8, y: 1 } })
    handler.hover?.(click(), 'file:///etc/passwd', { start: { x: 1, y: 1 }, end: { x: 6, y: 1 } })
    expect(t.opened).toEqual([])
    expect(t.host.querySelector('.caprock-link-tip')).toBeNull()
    t.teardown()
  })

  it('clears the handler on dispose', async () => {
    const t = await setup('')
    t.links.dispose()
    expect(t.term.options.linkHandler).toBeNull()
    t.term.dispose()
    t.host.remove()
  })
})
