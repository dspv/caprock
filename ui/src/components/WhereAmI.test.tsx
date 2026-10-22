/**
 * Where am I (.ai/04-ui.md § Where am I; owner, 2026-10-16, translated:
 * "sometimes it's unclear where you went and where you ended up … there must
 * be a button to return to the dashboard"): every page but Home names itself
 * in the header and the browser tab, highlights one item, and leads back to
 * Home in the same tab. Links that leave the dashboard say so (↗ + title).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Shell } from './Shell'
import { BackHome, TabPageBar } from './WhereAmI'
import { documentTitle, pageTitle } from '@/lib/pagetitle'
import { extProps, extTitle, opensElsewhere } from '@/lib/externalLinks'
import { parseHash, type Route } from '@/lib/router'

vi.mock('@/lib/live', async (orig) => {
  const actual = await orig<typeof import('@/lib/live')>()
  const link = { phase: 'live', attempt: 0, nextAt: null, downSince: null }
  return { ...actual, useLiveLink: () => link, live: { heardAt: () => Date.now(), reconnectNow: () => {}, onFrame: () => () => {} } }
})

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => ({ version: 'v0.9.4' }),
      update: async () => undefined,
      settings: async () => ({ update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0 }),
      premium: async () => ({
        yearly: { per_month_usd: 2.5, charged_usd: 30, period: 'year', url: 'https://buy/y' },
        monthly: { per_month_usd: 5, charged_usd: 5, period: 'month', url: 'https://buy/m' },
        lifetime: { per_month_usd: 0, charged_usd: 100, period: 'once', url: 'https://buy/l' },
        info_url: 'https://caprock.dev/premium/',
        license: { active: false, in_grace: false },
      }),
    },
  }
})

const header = () => document.querySelector<HTMLElement>('[data-shell-header]')!
const shell = (hash: string) => render(<Shell route={parseHash(hash)}>{null}</Shell>)

/** Every page a link can reach, by its address. */
const PAGES = ['#/work', '#/cost', '#/history', '#/week', '#/pipeline', '#/notes', '#/brain', '#/tasks', '#/queue', '#/mail', '#/settings', '#/session/abc', '#/graph', '#/start']

describe('where am I, in the header', () => {
  it('on Home: no way back, no page name, the tab says the product', () => {
    shell('#/')
    expect(header().querySelector('[data-back-home]')).toBeNull()
    expect(header().querySelector('[data-page-title]')).toBeNull()
    expect(document.title).toBe('caprock')
    expect(header().querySelectorAll('[aria-current="page"]')).toHaveLength(1)
  })

  it.each(PAGES)('on %s: ← Home back to #/ in this tab, the page named, at most one item current', (hash) => {
    const { unmount } = shell(hash)
    const way = header().querySelector<HTMLAnchorElement>('[data-back-home]')!
    expect(way).toBeInTheDocument()
    expect(way.getAttribute('href')).toBe('#/')
    // The same tab: no target, no new window.
    expect(way.getAttribute('target')).toBeNull()
    expect(way).toHaveTextContent('← Home')
    const title = pageTitle(parseHash(hash))
    expect(header().querySelector('[data-page-title]')).toHaveTextContent(title)
    expect(document.title).toBe(`${title} · caprock`)
    expect(header().querySelectorAll('[aria-current="page"]').length).toBeLessThanOrEqual(1)
    unmount()
  })

  it('highlights exactly one item on every page the nav or Settings names', () => {
    for (const hash of ['#/work', '#/cost', '#/pipeline', '#/mail', '#/settings', '#/session/abc']) {
      const { unmount } = shell(hash)
      const current = header().querySelectorAll('[aria-current="page"]')
      expect(current, hash).toHaveLength(1)
      unmount()
    }
    shell('#/settings')
    expect(header().querySelector('[data-settings-button]')).toHaveAttribute('aria-current', 'page')
  })

  it('follows the back link to Home', () => {
    location.hash = '#/cost'
    render(<BackHome />)
    fireEvent.click(screen.getByRole('link', { name: /Home/ }))
    // jsdom does not follow a hash link on click; the href is the contract.
    expect(screen.getByRole('link', { name: /Home/ })).toHaveAttribute('href', '#/')
  })

  it('keeps the way back on one line at phone width: the header wraps, the button never does', () => {
    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    shell('#/pipeline?repo=/Users/me/dev/caprock')
    const way = header().querySelector('[data-back-home]')!
    expect(way.className).toContain('whitespace-nowrap')
    expect(way.className).toContain('shrink-0')
    expect(header().className).toContain('flex-wrap')
    // The page's name truncates rather than pushing the row wider.
    expect(header().querySelector('[data-page-title]')!.className).toContain('truncate')
    expect(header().querySelector('[data-page-title]')).toHaveTextContent('Pipeline · caprock')
    window.innerWidth = 1024
  })
})

describe('page names', () => {
  const cases: [Route, string][] = [
    [{ name: 'pipeline', repo: 'C:\\dev\\caprock\\' }, 'Pipeline · caprock'],
    [{ name: 'pipeline' }, 'Pipeline'],
    [{ name: 'settings', section: 'phone' }, 'Settings · Phone'],
    [{ name: 'tasks', view: 'queue' }, 'Tasks · Queue'],
    [{ name: 'history' }, 'Lifetime'],
    [{ name: 'session', id: 'x' }, 'Session'],
  ]
  it.each(cases)('%o is %s', (r, name) => {
    expect(pageTitle(r)).toBe(name)
    expect(documentTitle(r)).toBe(`${name} · caprock`)
  })
})

describe('a page in a tab of its own (the app)', () => {
  it('leads back to the Dashboard tab and names the page', () => {
    const back = vi.fn()
    render(<TabPageBar title="Pipeline" onDashboard={back} />)
    expect(document.querySelector('[data-page-title]')).toHaveTextContent('Pipeline')
    fireEvent.click(screen.getByRole('button', { name: /Dashboard/ }))
    expect(back).toHaveBeenCalledOnce()
  })
})

describe('links that leave the dashboard', () => {
  it('say where they open: the browser from the app, a new tab from a browser', () => {
    expect(opensElsewhere(true)).toBe('Opens in your browser')
    expect(opensElsewhere(false)).toBe('Opens in a new tab')
    expect(extTitle('Open on GitHub', false)).toBe('Open on GitHub\nOpens in a new tab')
    expect(extProps()).toEqual({ 'data-ext': '', title: 'Opens in a new tab' })
  })

  it('every one in the header carries the mark and the title', () => {
    shell('#/cost')
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')) {
      expect(a.title, a.href).toMatch(/Opens in (your browser|a new tab)$/)
    }
  })

  // A guard over the source, so the next link added keeps the rule: every
  // <a target="_blank"> and every button that calls openExternal says where
  // it opens (extTitle / extProps), and so draws or spells the ↗.
  const files: string[] = []
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) files.push(p)
    }
  }
  walk(join(__dirname, '..'))

  /** The JSX opening tag that starts at `i`, braces and strings skipped. */
  const tagAt = (s: string, i: number): string => {
    let depth = 0
    let q = ''
    for (let j = i; j < s.length; j++) {
      const c = s[j]
      if (q) { if (c === q) q = ''; continue }
      if (depth === 0 && (c === '"' || c === "'")) q = c
      else if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) return s.slice(i, j + 1)
    }
    return s.slice(i)
  }

  it('every new-tab link and every openExternal button in the source says where it opens', () => {
    const bad: string[] = []
    for (const f of files) {
      const s = readFileSync(f, 'utf8')
      for (const m of s.matchAll(/<(a|button|BannerButton)(?=[\s>])/g)) {
        const tag = tagAt(s, m.index!)
        const leaves = m[1] === 'a' ? tag.includes('target="_blank"') : /onClick=\{[^]*?openExternal\(/.test(tag)
        if (!leaves) continue
        if (!/extTitle\(|extProps\(/.test(tag)) bad.push(`${f.split('/src/')[1]}: ${tag.slice(0, 90)}`)
      }
    }
    expect(bad).toEqual([])
  })
})
