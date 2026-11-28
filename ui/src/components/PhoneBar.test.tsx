import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PhoneBar } from './PhoneBar'

const link = { phase: 'live', attempt: 0, nextAt: 0, offlineSince: 0 } as unknown as Parameters<typeof PhoneBar>[0]['link']

describe('PhoneBar', () => {
  it('holds Chats, Dashboard, Settings and Feedback behind one ⋯, and nothing for sale', () => {
    render(<PhoneBar link={link} heardAt={() => Date.now()} />)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    const items = screen.getAllByRole('menuitem').map((e) => e.textContent?.replace(/[^A-Za-z ]/g, '').trim())
    expect(items).toEqual(['Chats', 'Talks', 'Dashboard', 'Settings', 'Feedback'])
    expect(screen.getByRole('menuitem', { name: 'Dashboard' }).getAttribute('href')).toBe('#/home')
    expect(screen.getByRole('menuitem', { name: 'Settings' }).getAttribute('href')).toBe('#/settings')
  })
})
