/** A start that ended at once, said with its last line and what it means (#1086). */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { announceStartExit } from '@/lib/startwatch'
import { earlyExitHint } from '@/lib/earlyexit'
import { StartExitToast, lastLine } from './StartExitToast'

const ID = 'f7kc4QaG4HRPYEjg19Pr-au-FeTljmKHkikFrAmRTzM'
const WARNING = 'WARNING: Claude Code running in Bypass Permissions mode\n\n❯ 1. No, exit\n  2. Yes, I accept\n'

describe('StartExitToast', () => {
  afterEach(cleanup)

  it('says which agent on which computer ended at once, its last line, what it means, and opens the session', () => {
    render(<StartExitToast />)
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => announceStartExit({ machine: ID, name: 'Windows PC', sessionId: 's1', report: { session_id: 's1', agent: 'claude', code: 0, early: true, ran_ms: 8200, tail: WARNING, at: 1 } }))
    const toast = screen.getByRole('alert')
    expect(toast.textContent).toMatch(/Claude Code on Windows PC exited at once \(code 0\)/)
    expect(toast.textContent).toMatch(/It ended 8 s after it started/)
    expect(toast.querySelector('[data-start-exit-line]')?.textContent).toBe('2. Yes, I accept')
    expect(toast.querySelector('[data-start-exit-hint]')?.textContent).toMatch(/one-time warning for skipping permissions/)
    expect(screen.getByRole('link', { name: 'Open the session' }).getAttribute('href')).toBe(`#/m/${ID}/session/s1`)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reads the bypass warning wherever the screen wrapped it', () => {
    expect(earlyExitHint('WARNING: Claude Code running in Bypass\nPermissions mode')).toMatch(/Accept and start/)
    expect(lastLine('a\n\n  b  \n\n')).toBe('b')
    expect(lastLine('')).toBe('')
  })
})
