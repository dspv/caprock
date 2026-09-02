/**
 * Release notes were shown as preformatted text, so a reader got `### Fixed`
 * as a literal heading and asterisks around every bold phrase — in a dialog
 * whose only job is to be read.
 *
 * The fix is not a Markdown library. These tests hold both halves of that: the
 * shapes our notes use are rendered, and nothing remote can become markup.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReleaseNotes, parseNotes, inlines } from './ReleaseNotes'

const real = `### Fixed

- **Why a weekly report never arrived is remembered now.** The reason a send
  failed was held in memory, so restarting the daemon erased it.

  This matters because of how the feature fails: a message that stops
  arriving is an absence.`

describe('what a reader actually sees', () => {
  it('turns a heading into a heading, not into hashes', () => {
    render(<ReleaseNotes text={real} />)
    expect(screen.getByText('Fixed').tagName).toBe('H3')
    expect(screen.queryByText(/###/)).toBeNull()
  })

  it('bolds without showing the asterisks', () => {
    render(<ReleaseNotes text={real} />)
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
    render(<ReleaseNotes text={'- something changed'} />)
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
    render(<ReleaseNotes text={'<img src=x onerror=alert(1)> and <b>bold</b>'} />)
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('b')).toBeNull()
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('never produces a link', () => {
    render(<ReleaseNotes text={'[click](https://evil.example) and https://evil.example'} />)
    expect(document.querySelector('a')).toBeNull()
  })

  it('leaves a stray asterisk alone', () => {
    // An unmatched marker is prose, not a broken tag.
    const parts = inlines('2 * 3 is six')
    expect(parts.map((p) => p.text).join('')).toBe('2 * 3 is six')
    expect(parts.some((p) => p.bold)).toBe(false)
  })
})
