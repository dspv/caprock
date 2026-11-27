import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FileText } from './FileChip'
import { tidyDescription } from '@/lib/api'

const pdf = '/Users/me/Library/Application Support/caprock/paste/drop-1795599021771608000/Some_File_Name.pdf'

describe('FileText — a file in a prompt is a chip', () => {
  afterEach(cleanup)

  it('draws a PDF as a chip with its name and the words around it', () => {
    const { container } = render(<div><FileText text={`"${pdf}" how is my CV?`} /></div>)
    const chip = container.querySelector('[data-path-chip="pdf"]')
    expect(chip).not.toBeNull()
    expect(chip?.querySelector('[data-file-icon="pdf"]')).not.toBeNull()
    expect(chip?.textContent).toContain('Some_File_Name.pdf')
    expect(container.textContent).not.toContain('Application Support')
    expect(container.textContent).toContain(' how is my CV?')
  })

  it('shows the whole path on hover and on a click', () => {
    render(<FileText text={`"${pdf}" ok`} />)
    const button = screen.getByRole('button', { name: /Some_File_Name\.pdf/ })
    expect(button.getAttribute('title')).toBe(pdf)
    expect(screen.queryByText(pdf)).toBeNull()
    fireEvent.click(button)
    expect(screen.getByText(pdf)).toBeTruthy()
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })

  it('leaves an image path and plain words as written', () => {
    const { container } = render(<FileText text={'"/tmp/a/shot.png" and src/lib/a.ts'} />)
    expect(container.querySelector('[data-path-chip]')).toBeNull()
    expect(container.textContent).toBe('"/tmp/a/shot.png" and src/lib/a.ts')
  })

  it('draws several files, each its own chip', () => {
    const { container } = render(<FileText text={String.raw`"/a/1.pdf" "C:\work\notes.md" compare`} />)
    expect([...container.querySelectorAll('[data-path-chip]')].map((c) => c.getAttribute('data-path-chip'))).toEqual(['pdf', 'text'])
  })
})

describe('tidyDescription — a session row names the file, not its path', () => {
  it('cuts the paths in a first prompt and leaves a title alone', () => {
    expect(tidyDescription({ description: `"${pdf}" how is my CV?`, description_source: 'prompt' }).description).toBe('Some_File_Name.pdf how is my CV?')
    const title = { description: `"${pdf}"`, description_source: 'title' }
    expect(tidyDescription(title)).toBe(title)
  })
})
