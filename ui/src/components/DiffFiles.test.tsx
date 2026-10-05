import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { DiffFiles } from './DiffFiles'
import type { FileDiff } from '@/lib/api'

const file = (path: string, patch = `@@ -1 +1 @@\n+in ${path}`): FileDiff => ({ path, status: 'modified', additions: 1, deletions: 0, patch })

function Harness({ files, onAsk, initial = [] }: { files: FileDiff[]; onAsk?: (p: string, l: number) => void; initial?: string[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set(initial))
  return <DiffFiles files={files} open={open} setOpen={setOpen} wrap onAsk={onAsk} />
}

describe('DiffFiles', () => {
  // Reading a diff on a phone is file after file: "next" closes this one and
  // opens the one after, so the list does not grow with every file read.
  it('moves to the next file', () => {
    render(<Harness files={[file('a.ts'), file('b.ts')]} initial={['a.ts']} />)
    expect(screen.getByText('in a.ts')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next file: b.ts' }))
    expect(screen.queryByText('in a.ts')).not.toBeInTheDocument()
    expect(screen.getByText('in b.ts')).toBeInTheDocument()
  })

  it('draws a long patch a page at a time', () => {
    const body = Array.from({ length: 1000 }, (_, i) => `+line ${i}`).join('\n')
    render(<Harness files={[file('big.ts', `@@ -0,0 +1,1000 @@\n${body}`)]} initial={['big.ts']} />)
    expect(screen.getByText('line 398')).toBeInTheDocument()
    expect(screen.queryByText('line 500')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Show 400 more lines'))
    expect(screen.getByText('line 500')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Show all 1001'))
    expect(screen.getByText('line 999')).toBeInTheDocument()
  })

  it('cuts a very long line until asked', () => {
    const long = 'x'.repeat(5000)
    render(<Harness files={[file('min.json', `@@ -1 +1 @@\n+${long}`)]} initial={['min.json']} />)
    expect(screen.queryByText(long)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText(/more characters/))
    expect(screen.getByText(long)).toBeInTheDocument()
  })

  it('offers to ask the agent about a tapped line only when it may', () => {
    const { unmount } = render(<Harness files={[file('a.ts', '@@ -4,2 +4,2 @@\n ctx\n+new')]} initial={['a.ts']} />)
    fireEvent.click(screen.getByText('new'))
    expect(screen.queryByText('Ask the agent')).not.toBeInTheDocument()
    unmount()

    const onAsk = vi.fn()
    render(<Harness files={[file('src/a.ts', '@@ -4,2 +4,2 @@\n ctx\n+new')]} initial={['src/a.ts']} onAsk={onAsk} />)
    fireEvent.click(screen.getByText('new'))
    fireEvent.click(screen.getByText('Ask the agent'))
    expect(onAsk).toHaveBeenCalledWith('src/a.ts', 5)
  })
})
