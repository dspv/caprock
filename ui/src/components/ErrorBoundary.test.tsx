import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

const opened = vi.hoisted(() => [] as string[])
vi.mock('@/lib/nudges', () => ({ openExternal: (u: string) => { opened.push(u) } }))

function Boom(): never { throw new TypeError("Cannot read properties of null (reading 'some')") }

describe('ErrorBoundary', () => {
  afterEach(() => { opened.length = 0; vi.restoreAllMocks() })

  // A throw at the root left the app's window black with nothing to press.
  it('full: a calm screen with reload, reset and a report the user sends', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary full><Boom /></ErrorBoundary>)
    expect(screen.getByText('Caprock hit a snag')).toBeTruthy()
    expect(screen.getByText(/nothing was lost/)).toBeTruthy()
    expect(screen.getByText('Reload')).toBeTruthy()
    expect(screen.getByText('Reset the view and reload')).toBeTruthy()
    fireEvent.click(screen.getByText('Report on GitHub'))
    fireEvent.click(screen.getByText('Email us'))
    expect(opened[0]).toMatch(/^https:\/\/github\.com\/dspv\/caprock\/issues\/new\?/)
    expect(opened[1]).toMatch(/^mailto:hi@caprock\.dev\?/)
  })

  it('inline: one panel fails, with retry and the same report', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<div><p>terminal</p><ErrorBoundary label="The deck"><Boom /></ErrorBoundary></div>)
    expect(screen.getByText('terminal')).toBeTruthy()
    expect(screen.getByText('The deck failed to render')).toBeTruthy()
    expect(screen.getByText('Report on GitHub')).toBeTruthy()
  })
})
