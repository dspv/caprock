import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Panel } from './ui'
import { ShareWith } from './PanelShare'
import { HIDE_NAMES_KEY, mdTable } from '@/lib/panelShare'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

function Repos({ text = true }: { text?: boolean }) {
  return (
    <Panel title="Repos" share="Repos" right={<span>local git</span>}>
      <ShareWith names={() => [{ kind: 'project', value: 'caprock' }, { kind: 'branch', value: 'main' }]}
        toText={text ? (alias) => mdTable(['Repository', 'Branch', 'Today'], [[alias('project', 'caprock'), alias('branch', 'main'), 3]]) : undefined} />
      <p>caprock on main</p>
    </Panel>
  )
}

describe('a panel share button', () => {
  it('is offered only where the panel opts in', () => {
    render(<Panel title="Settings"><p>form</p></Panel>)
    expect(document.querySelector('[data-panel-share]')).toBeNull()
    cleanup()
    render(<Repos />)
    expect(screen.getByRole('button', { name: 'Share Repos' })).toBeTruthy()
  })

  it('opens a menu with the four ways and the names tick on by default', () => {
    render(<Repos />)
    fireEvent.click(screen.getByRole('button', { name: 'Share Repos' }))
    const menu = screen.getByRole('menu', { name: 'Share Repos' })
    expect(menu.textContent).toContain('Copy image')
    expect(menu.textContent).toContain('Save PNG')
    expect(menu.textContent).toContain('Copy as text')
    expect(menu.textContent).toContain('Post to X, Threads or LinkedIn…')
    expect((menu.querySelector('[data-panel-share-hide]') as HTMLInputElement).checked).toBe(true)
  })

  it('leaves Copy as text out when the panel wrote no text', () => {
    render(<Repos text={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Share Repos' }))
    expect(screen.getByRole('menu').textContent).not.toContain('Copy as text')
  })

  it('copies the text with the names hidden, then shown once the tick is off — and remembers it', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    render(<Repos />)
    fireEvent.click(screen.getByRole('button', { name: 'Share Repos' }))
    await act(async () => { fireEvent.click(screen.getByText('Copy as text')) })
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    const hidden = write.mock.calls[0]![0] as string
    expect(hidden).toContain('## Repos')
    expect(hidden).toContain('| project 1 | branch 1 | 3 |')
    expect(hidden).not.toContain('caprock |')
    expect(hidden).toContain('via caprock.dev')

    fireEvent.click(screen.getByRole('menu').querySelector('[data-panel-share-hide]')!)
    expect(localStorage.getItem(HIDE_NAMES_KEY)).toBe('off')
    await act(async () => { fireEvent.click(screen.getByText('Copy as text')) })
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(write.mock.calls[1]![0]).toContain('| caprock | main | 3 |')
  })

  it('is not drawn while the panel is folded', () => {
    localStorage.setItem('caprock.panel.folds', JSON.stringify(['t.repos']))
    render(<Panel title="Repos" share="Repos" fold="t.repos"><p>x</p></Panel>)
    expect(document.querySelector('[data-panel-share]')).toBeNull()
  })
})
