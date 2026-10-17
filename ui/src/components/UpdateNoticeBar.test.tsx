import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { UpdateNoticeBar } from './UpdateNoticeBar'

const notice = {
  agent: 'codex' as const,
  version: '0.162.0',
  command: "sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'",
}

describe('UpdateNoticeBar', () => {
  it('copies the exact command and says so; opens a terminal; dismisses', async () => {
    const copy = vi.fn(async () => true)
    const onOpenShell = vi.fn()
    const onDismiss = vi.fn()
    render(<UpdateNoticeBar notice={notice} copy={copy} onOpenShell={onOpenShell} onDismiss={onDismiss} />)
    expect(screen.getByText('Codex 0.162.0 available')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
    expect(copy).toHaveBeenCalledWith(notice.command)
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open a terminal' }))
    expect(onOpenShell).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /^Dismiss/ }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('says when the clipboard refused', async () => {
    render(<UpdateNoticeBar notice={notice} copy={async () => false} onOpenShell={() => {}} onDismiss={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
    expect(await screen.findByRole('button', { name: 'Could not copy' })).toBeTruthy()
  })
})
