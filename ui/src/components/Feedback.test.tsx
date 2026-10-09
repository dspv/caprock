import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const opened: string[] = []
vi.mock('@/lib/nudges', async (orig) => ({
  ...(await orig<typeof import('@/lib/nudges')>()),
  openExternal: (url: string) => { opened.push(url) },
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, status: () => Promise.reject(new Error('down')) } }
})

import { FeedbackButton } from './Feedback'
import { currentScreen } from '@/lib/feedback'

/** Owner, 2026-10-10: an 11px grey "feedback" in the header went unnoticed. */
describe('the feedback button', () => {
  it('is a labelled button, and the issue opens through the app’s browser path', () => {
    render(<FeedbackButton screen="Cost" />)
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    const dialog = screen.getByRole('dialog', { name: 'Feedback' })
    expect(dialog).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'The cost chart is crooked' } })
    fireEvent.click(screen.getByRole('button', { name: /Open a GitHub issue/ }))
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatch(/^https:\/\/github\.com\/dspv\/caprock\/issues\/new\?/)
    expect(decodeURIComponent(opened[0]!.replace(/\+/g, ' '))).toContain('[bug] Cost: The cost chart is crooked')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes with its ×, Escape and the backdrop like every dialog', () => {
    render(<FeedbackButton screen="Now" />)
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    const backdrop = screen.getByRole('dialog').parentElement!
    fireEvent.mouseDown(backdrop)
    fireEvent.click(backdrop)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('has an icon form for the app sidebar that names the screen in front', () => {
    render(<FeedbackButton variant="icon" />)
    expect(screen.getByRole('button', { name: 'Send feedback' })).toBeTruthy()
    expect(currentScreen('#/app', true)).toBe('App tabs')
    expect(currentScreen('#/cost', true)).toBe('Cost')
    expect(currentScreen('', false)).toBe('Now')
  })
})
