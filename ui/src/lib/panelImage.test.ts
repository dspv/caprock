import { afterEach, describe, expect, it, vi } from 'vitest'

// What html-to-image was handed: the frame as it stood, and its options.
const seen: { html: string; text: string; filter?: (n: Node) => boolean }[] = []
vi.mock('html-to-image', () => ({
  toBlob: vi.fn(async (node: HTMLElement, opts: { filter?: (n: Node) => boolean }) => {
    seen.push({ html: node.innerHTML, text: node.textContent ?? '', filter: opts.filter })
    return new Blob(['png'], { type: 'image/png' })
  }),
}))

import { renderPanelPNG } from './panelImage'
import { Aliaser } from './panelShare'

afterEach(() => { seen.length = 0; document.body.innerHTML = '' })

function panel(): HTMLElement {
  const s = document.createElement('section')
  s.innerHTML = '<header><h2 data-share-keep><button><span aria-hidden data-share-skip>›</span>Live pulse</button></h2>'
    + '<button data-panel-share class="opacity-0 group-hover/panel:opacity-100">share</button></header>'
    + '<div><button data-share-skip>›</button><b>navige</b> <span data-share-name="branch">feat/tail</span>'
    + ' · <span data-share-activity>editing navige/src/x.go</span>'
    + '<div data-share-skip aria-label="Ways in"><a href="#/session">Open session</a></div>'
    + '<span role="tooltip">a hover card</span>$4.20</div>'
  s.getBoundingClientRect = () => ({ width: 600, height: 200, top: 0, left: 0, right: 600, bottom: 200, x: 0, y: 0, toJSON: () => ({}) })
  document.body.append(s)
  return s
}

describe('renderPanelPNG', () => {
  it('draws the title and the content: no chevrons, toggles, links or tooltips, the names hidden', async () => {
    const s = panel()
    const blob = await renderPanelPNG(s, new Aliaser(true, [{ kind: 'project', value: 'navige' }]), new Date(2026, 9, 30, 9, 5))
    expect(blob).not.toBeNull()
    const { text, html, filter } = seen[0]!
    expect(text).toBe('Live pulseproject 1 branch 1 · editing path 1$4.2030 Oct 2026, 09:05caprock.dev')
    expect(html).not.toContain('data-share-skip')
    expect(html).not.toContain('data-panel-share=')
    expect(html).not.toContain('tooltip')
    // The same rule is the drawing's filter, for anything added after the copy.
    const late = document.createElement('button')
    late.setAttribute('data-share-skip', '')
    expect(filter?.(late)).toBe(false)
    expect(filter?.(document.createElement('div'))).toBe(true)
    // The screen is not touched.
    expect(s.textContent).toContain('navige')
    expect(s.querySelector('[data-panel-share]')).not.toBeNull()
  })

  it('keeps the names with Hide project names off, and still leaves the chrome out', async () => {
    await renderPanelPNG(panel(), new Aliaser(false, [{ kind: 'project', value: 'navige' }]), new Date(2026, 9, 30, 9, 5))
    expect(seen[0]!.text).toBe('Live pulsenavige feat/tail · editing navige/src/x.go$4.2030 Oct 2026, 09:05caprock.dev')
  })
})
