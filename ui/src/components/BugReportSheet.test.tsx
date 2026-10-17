import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { decodedBytes, reportBody, reportProblem, SUPPORT_LIMITS } from '@/lib/support'
import { BUG_SENT, BugReportSheet } from './BugReportSheet'

const m = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, sendSupport: m.send } }
})

beforeEach(() => {
  m.send.mockReset().mockResolvedValue({ ok: true })
})

const PRIVACY = 'Sent to Caprock support (caprock.dev), not GitHub: your text, the screenshots you attached, your email if given, Caprock version and OS. Nothing else — no transcripts, no logs.'

const textField = () => screen.getByRole('textbox', { name: 'What happened?' })
const sendButton = () => screen.getByRole('button', { name: 'Send to support' })
const fileInput = () => screen.getByLabelText('Add screenshot', { selector: 'input' }) as HTMLInputElement

function png(name: string, bytes = 16): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' })
}

describe('the bug report sheet', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<BugReportSheet open={false} onClose={() => {}} />)
    expect(container.innerHTML).toBe('')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names every field that is sent, word for word, before the button', () => {
    render(<BugReportSheet open onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Report a bug' })
    expect(screen.getByRole('heading', { name: 'Report a bug' })).toBeTruthy()
    expect(screen.getByText('Type, or tap the mic on your keyboard to dictate')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Email for a reply (optional)' })).toBeTruthy()
    const privacy = dialog.querySelector('[data-bug-privacy]')!
    expect(privacy.textContent).toBe(PRIVACY)
    // Before the button in the document order.
    expect(privacy.compareDocumentPosition(sendButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('asks for text first and sends nothing without it', () => {
    render(<BugReportSheet open onClose={() => {}} />)
    fireEvent.click(sendButton())
    expect(screen.getByRole('alert').textContent).toBe('Say what happened first.')
    expect(m.send).not.toHaveBeenCalled()
  })

  it('sends the text, the email and the screenshots, then thanks and closes', async () => {
    const onClose = vi.fn()
    const { rerender } = render(<BugReportSheet open onClose={onClose} />)
    fireEvent.change(textField(), { target: { value: 'The deck went blank' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Email for a reply (optional)' }), { target: { value: ' me@example.com ' } })
    fireEvent.change(fileInput(), { target: { files: [png('a.png')] } })
    await screen.findByRole('img', { name: 'a.png' })
    fireEvent.click(sendButton())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(m.send).toHaveBeenCalledTimes(1)
    const body = m.send.mock.calls[0]![0]
    expect(body).toEqual({
      text: 'The deck went blank',
      email: 'me@example.com',
      screenshots: [{ name: 'a.png', type: 'image/png', data: btoa('\0'.repeat(16)) }],
    })
    rerender(<BugReportSheet open={false} onClose={onClose} />)
    expect(screen.getByRole('status').textContent).toBe(BUG_SENT)
    // Sent: the form starts empty next time.
    rerender(<BugReportSheet open onClose={onClose} />)
    expect((textField() as HTMLTextAreaElement).value).toBe('')
  })

  it('leaves out the email and screenshots when there are none', async () => {
    render(<BugReportSheet open onClose={() => {}} />)
    fireEvent.change(textField(), { target: { value: 'x' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(m.send).toHaveBeenCalled())
    expect(m.send.mock.calls[0]![0]).toEqual({ text: 'x' })
  })

  it('disables the button while sending, and keeps the form on an error', async () => {
    let fail: (e: unknown) => void = () => {}
    m.send.mockReturnValue(new Promise((_, reject) => { fail = reject }))
    const onClose = vi.fn()
    render(<BugReportSheet open onClose={onClose} />)
    fireEvent.change(textField(), { target: { value: 'Broken' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect((sendButton() as HTMLButtonElement).disabled).toBe(true))
    fireEvent.click(sendButton())
    expect(m.send).toHaveBeenCalledTimes(1)
    fail(new ApiError(502, '502 Bad Gateway', { error: 'caprock.dev answered 500' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('caprock.dev answered 500')
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false)
    expect((textField() as HTMLTextAreaElement).value).toBe('Broken')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('takes at most three screenshots, each removable', async () => {
    render(<BugReportSheet open onClose={() => {}} />)
    fireEvent.change(fileInput(), { target: { files: [png('1.png'), png('2.png'), png('3.png'), png('4.png')] } })
    await screen.findByRole('img', { name: '3.png' })
    expect(screen.queryByRole('img', { name: '4.png' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('At most 3 screenshots')
    // Full: no more to add.
    expect(screen.queryByRole('button', { name: '+ Add screenshot' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove screenshot 2.png' }))
    expect(screen.queryByRole('img', { name: '2.png' })).toBeNull()
    expect(screen.getByRole('button', { name: '+ Add screenshot' })).toBeTruthy()
  })

  it('refuses a file that is not an image', async () => {
    render(<BugReportSheet open onClose={() => {}} />)
    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('is not an image'))
    expect(screen.queryAllByRole('img')).toHaveLength(0)
  })
})

describe('the report limits', () => {
  const shot = (bytes: number) => ({ name: 's.jpg', type: 'image/jpeg' as const, data: 'A'.repeat(Math.ceil((bytes * 4) / 3)) })

  it('counts characters, not bytes, up to 8000', () => {
    expect(reportProblem({ text: 'é'.repeat(SUPPORT_LIMITS.text) })).toBeNull()
    expect(reportProblem({ text: 'é'.repeat(SUPPORT_LIMITS.text + 1) })).toMatch(/8,000/)
    expect(reportProblem({ text: '   ' })).toBe('Say what happened first.')
  })

  it('holds the screenshots to 3, 4 MB each and 8 MB together', () => {
    expect(reportProblem({ text: 'x', screenshots: [shot(10), shot(10), shot(10), shot(10)] })).toMatch(/At most 3/)
    expect(reportProblem({ text: 'x', screenshots: [shot(4 * 1024 * 1024 + 3)] })).toMatch(/over 4 MB/)
    expect(reportProblem({ text: 'x', screenshots: [shot(3 << 20), shot(3 << 20), shot(3 << 20)] })).toMatch(/over 8 MB/)
    expect(reportProblem({ text: 'x', screenshots: [shot(2 << 20), shot(2 << 20), shot(2 << 20)] })).toBeNull()
  })

  it('checks the email only when one is typed', () => {
    expect(reportProblem({ text: 'x', email: '' })).toBeNull()
    expect(reportProblem({ text: 'x', email: 'nope' })).toMatch(/address/)
    expect(reportBody({ text: 'x', email: '  ', screenshots: [] })).toEqual({ text: 'x' })
  })

  it('reads the decoded size off base64', () => {
    expect(decodedBytes(btoa('abc'))).toBe(3)
    expect(decodedBytes(btoa('ab'))).toBe(2)
    expect(decodedBytes(btoa('a'))).toBe(1)
  })
})
