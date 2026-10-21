/**
 * Release notes were shown as preformatted text, so a reader got `### Fixed`
 * as a literal heading and asterisks around every bold phrase — in a dialog
 * whose only job is to be read.
 *
 * The fix is not a Markdown library. These tests hold both halves of that: the
 * shapes our notes use are rendered, and nothing remote can become markup.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Prose, ProseDoc, parseDoc, parseNotes, inlines } from './Prose'

describe('a document (the file tab)', () => {
  it('keeps heading levels, numbered and nested items, and a fence verbatim', () => {
    const blocks = parseDoc('## Install\n\n1. Clone it\n   - with **ssh**\n2. Run\n\n```go\nfunc main() {\n\n}\n```\n---\nend')
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'item', 'item', 'item', 'code', 'rule', 'para'])
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 2 })
    expect(blocks[1]).toMatchObject({ marker: '1.', depth: 0 })
    expect(blocks[2]).toMatchObject({ marker: '·', depth: 1 })
    expect(blocks[4]).toEqual({ kind: 'code', lang: 'go', text: 'func main() {\n\n}' })
  })

  it('turns a .md path in a reply into a button that opens it, and leaves a URL text', () => {
    const onPath = vi.fn()
    render(<Prose text={'I wrote `docs/PLAN.md` and /Users/me/app/NOTES.md:3; see https://x.dev/a.md'} onPath={onPath} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['docs/PLAN.md', '/Users/me/app/NOTES.md:3'])
    fireEvent.click(buttons[1]!)
    expect(onPath).toHaveBeenCalledWith('/Users/me/app/NOTES.md')
  })

  it('reads a quote wrapped over several lines as one, and task items as boxes', () => {
    const blocks = parseDoc('> one\n> two\n\n> three\n\n- [x] done\n- [ ] open')
    expect(blocks.filter((b) => b.kind === 'quote')).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ kind: 'quote', parts: [{ text: 'one two' }] })
    expect(blocks.slice(2).map((b) => (b.kind === 'item' ? b.task : null))).toEqual(['done', 'open'])
  })

  it('the chat renderer links a web address too, and only that (2026-10-21)', () => {
    render(<Prose text={'See [the site](https://caprock.dev) and [a file](docs/a.md).'} />)
    expect([...document.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://caprock.dev/'])
  })
})

const real = `### Fixed

- **Why a weekly report never arrived is remembered now.** The reason a send
  failed was held in memory, so restarting the daemon erased it.

  This matters because of how the feature fails: a message that stops
  arriving is an absence.`

describe('what a reader actually sees', () => {
  it('turns a heading into a heading, not into hashes', () => {
    render(<Prose text={real} />)
    expect(screen.getByText('Fixed').tagName).toBe('H3')
    expect(screen.queryByText(/###/)).toBeNull()
  })

  it('bolds without showing the asterisks', () => {
    render(<Prose text={real} />)
    const strong = screen.getByText(/Why a weekly report never arrived/)
    expect(strong.tagName).toBe('STRONG')
    expect(document.body.textContent).not.toContain('**')
  })

  it('joins a hard-wrapped paragraph back into one', () => {
    // Changelog entries wrap at eighty columns for the sake of diffs. Showing
    // those breaks in a dialog of another width looks like broken text.
    const blocks = parseNotes(real)
    const bullet = blocks.find((b) => b.kind === 'bullet')
    expect(bullet).toBeDefined()
    const text = bullet!.kind === 'bullet' ? bullet!.parts.map((p) => p.text).join('') : ''
    expect(text).toContain('failed was held in memory, so restarting')
    expect(text).not.toContain('\n')
  })

  it('renders a bullet as one, without the dash', () => {
    render(<Prose text={'- something changed'} />)
    expect(screen.getByText('something changed')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('- something')
  })
})

describe('remote text cannot become markup', () => {
  // The notes come from GitHub. They are written by us, but a dialog that
  // renders remote markup is a surface a local-first tool has no reason to
  // open — which was the right instinct behind showing raw text, kept here
  // without the cost of being unreadable.
  it('shows html as text', () => {
    render(<Prose text={'<img src=x onerror=alert(1)> and <b>bold</b>'} />)
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('b')).toBeNull()
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('makes a link only of an http(s) address, in a new tab', () => {
    render(<Prose text={'[click](javascript:alert(1)) <file:///etc/passwd> javascript:alert(2)'} />)
    expect(document.querySelector('a')).toBeNull()
  })
})

describe('a link in a reply can be tapped', () => {
  it('a bare address, a markdown link and an angle-bracket one all become links', () => {
    render(<Prose text={'See https://github.com/dspv/caprock/pull/768#issuecomment-6322183824. Also [the artifact](https://claude.ai/artifact/XUWK6T8BAtS4msXnSYrbyY) and <https://example.com/é>.'} />)
    const as = [...document.querySelectorAll('a')]
    expect(as.map((a) => a.getAttribute('href'))).toEqual([
      'https://github.com/dspv/caprock/pull/768#issuecomment-6322183824',
      'https://claude.ai/artifact/XUWK6T8BAtS4msXnSYrbyY',
      'https://example.com/%C3%A9',
    ])
    expect(as[1]).toHaveTextContent('the artifact')
    for (const a of as) {
      expect(a.target).toBe('_blank')
      expect(a.rel).toBe('noreferrer noopener')
    }
    expect(document.body.textContent).toContain('6322183824. Also')
  })

  it('not inside code, and not as a .md path inside an address', () => {
    const onPath = vi.fn()
    render(<Prose text={'Run `curl https://example.com/x` then read https://example.com/docs/PLAN.md and docs/PLAN.md'} onPath={onPath} />)
    expect([...document.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://example.com/docs/PLAN.md'])
    expect(document.querySelector('code')?.querySelector('a')).toBeNull()
    expect(document.querySelectorAll('[data-md-path]')).toHaveLength(1)
  })

  it('in bold text, a table cell and a document too', () => {
    render(<Prose text={'**see https://example.com/a**\n\n| a | https://example.com/b |\n| - | - |'} />)
    expect([...document.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a', 'https://example.com/b'])
  })

  it('a document links a bare address whole, underscores and all, and not in code', () => {
    const blocks = parseDoc('Go to https://example.com/_a_b_/c_d. Or `https://example.com/code`.')
    const parts = blocks[0]!.kind === 'para' ? blocks[0]!.parts : []
    expect(parts.filter((p) => p.href).map((p) => p.href)).toEqual(['https://example.com/_a_b_/c_d'])
    expect(parts.some((p) => p.italic)).toBe(false)
    render(<ProseDoc text={'Go to https://example.com/_a_b_/c_d and [rel](docs/a.md).'} />)
    expect([...document.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://example.com/_a_b_/c_d'])
  })

  it('leaves a stray asterisk alone', () => {
    // An unmatched marker is prose, not a broken tag.
    const parts = inlines('2 * 3 is six')
    expect(parts.map((p) => p.text).join('')).toBe('2 * 3 is six')
    expect(parts.some((p) => p.bold)).toBe(false)
  })
})
