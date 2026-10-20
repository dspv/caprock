import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProjectMenu } from './ProjectMenu'

const menu = (tabs: number, chats?: number) => render(
  <ProjectMenu at={{ projectId: 'p', x: 0, y: 0 }} name="app" root="/w/app" hidden={false} tabs={tabs} chats={chats} editors={null} onCloseTabs={vi.fn()} onClose={vi.fn()} />,
)

// Owner, 2026-10-20: closing tabs in bulk now ends their quick chats, as ⌘W does.
describe('a project menu’s Close tabs', () => {
  it('says what happens to what the tabs show', () => {
    menu(2)
    expect(screen.getByRole('menuitem', { name: /Close its 2 tabs/ })).toHaveTextContent('they keep running')
  })

  it('says a quick chat ends with its tab', () => {
    menu(1, 1)
    expect(screen.getByRole('menuitem', { name: /Close its tab/ })).toHaveTextContent('the chat ends')
  })

  it('says chats end and agents run on when it closes both', () => {
    menu(3, 1)
    expect(screen.getByRole('menuitem', { name: /Close its 3 tabs/ })).toHaveTextContent('chats end, agents run on')
  })
})
