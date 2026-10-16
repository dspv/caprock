/**
 * Send to someone in Telegram opens the Telegram app at its chat picker
 * when the desktop shell finds one, and the web link when it does not
 * (ShareActions.tsx, app/src-tauri/src/commands.rs).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({ on: false }))
const openShell = vi.hoisted(() => vi.fn(async (_url: string) => {}))
vi.mock('@/lib/appmode', async (orig) => ({ ...(await orig<typeof import('@/lib/appmode')>()), isTauri: () => tauri.on }))
vi.mock('@/lib/shell', async (orig) => {
  const real = await orig<typeof import('@/lib/shell')>()
  return { ...real, shell: { ...real.shell, openExternal: (url: string) => openShell(url) } }
})

import { openTelegram, telegramAppShareURL } from './ShareActions'

afterEach(() => { tauri.on = false; openShell.mockReset(); vi.restoreAllMocks() })

describe('openTelegram', () => {
  it('asks the shell for the app link, with the words', async () => {
    tauri.on = true
    expect(await openTelegram('a GitHub repo shipped 4 PRs')).toBe('app')
    expect(openShell).toHaveBeenCalledTimes(1)
    const url = new URL(openShell.mock.calls[0]![0])
    expect(url.protocol).toBe('tg:')
    expect(url.searchParams.get('text')).toBe('a GitHub repo shipped 4 PRs')
    expect(url.searchParams.get('url')).toBe('https://caprock.dev')
  })

  it('falls back to t.me when no Telegram app is here', async () => {
    tauri.on = true
    openShell.mockRejectedValueOnce(new Error('no app here opens this link'))
    openShell.mockResolvedValueOnce(undefined)
    expect(await openTelegram('hi')).toBe('web')
    expect(openShell.mock.calls[1]![0]).toMatch(/^https:\/\/t\.me\/share\/url\?/)
  })

  it('in a browser goes straight to t.me', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect(await openTelegram('hi')).toBe('web')
    expect(openShell).not.toHaveBeenCalled()
    expect(open.mock.calls[0]![0]).toMatch(/^https:\/\/t\.me\/share\/url\?/)
  })

  it('builds the app link Telegram documents', () => {
    expect(telegramAppShareURL('x y')).toBe('tg://msg_url?url=https%3A%2F%2Fcaprock.dev&text=x%20y')
  })
})
