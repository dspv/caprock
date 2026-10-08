/**
 * "Open file…": the worktree's list read once, filtered here as you type,
 * Enter opening the best match in a tab.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilePicker } from './FilePicker'

let urls: string[] = []
beforeEach(() => {
  urls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify({ files: ['README.md', 'docs/app.md', 'internal/api/files.go', 'ui/src/components/FileView.tsx'] }), { status: 200 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Open file…', () => {
  it('lists the worktree once and opens the best match on Enter', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const onOpen = vi.fn()
    render(<FilePicker target={{ projectId: '7', worktree: 'feat' }} title="repo · feat" onOpen={onOpen} onClose={() => {}} />)
    expect(await screen.findByText('README.md')).toBeInTheDocument()
    expect(urls).toEqual(['/v1/projects/7/files?worktree=feat'])
    const input = screen.getByLabelText('File name')
    fireEvent.change(input, { target: { value: 'fview' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Enter' })
    vi.runAllTimers()
    expect(onOpen).toHaveBeenCalledWith('ui/src/components/FileView.tsx')
    expect(urls).toHaveLength(1)
    vi.useRealTimers()
  })

  it('says when nothing matches', async () => {
    render(<FilePicker target={{ projectId: '7', worktree: '' }} title="repo" onOpen={() => {}} onClose={() => {}} />)
    await screen.findByText('README.md')
    fireEvent.change(screen.getByLabelText('File name'), { target: { value: 'zzz' } })
    expect(screen.getByText('No file matches “zzz”.')).toBeInTheDocument()
  })
})
