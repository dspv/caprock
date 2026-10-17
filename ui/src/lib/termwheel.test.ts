import { describe, expect, it } from 'vitest'
import { Terminal as Xterm } from '@xterm/xterm'

// What the wheel does in a Caprock terminal depends on two things the output
// set: the screen (normal or alternate) and mouse tracking. Codex (codex-cli
// 0.161) owns its transcript on the alternate screen and asks for SGR mouse
// reports (codex-rs/tui/src/tui/alternate_screen.rs); the daemon's snapshot
// replays those modes even after the startup scrolled out of its ring
// (internal/termbuf). These pin how xterm reads that prefix.

const PREFIX = '\x1b[?1000l\x1b[?1002l\x1b[?1003h\x1b[?1006h\x1b[?1049h'

const write = (t: Xterm, s: string) => new Promise<void>((r) => t.write(s, r))

describe('a replayed Codex terminal', () => {
  it('is on the alternate screen with SGR any-event mouse reports once the prefix is written', async () => {
    const t = new Xterm({ cols: 40, rows: 10 })
    await write(t, PREFIX + 'frame')
    expect(t.buffer.active.type).toBe('alternate')
    expect(t.modes.mouseTrackingMode).toBe('any')
    t.dispose()
  })

  it('without it is on the normal screen with the mouse off: the wheel never reaches Codex', async () => {
    const t = new Xterm({ cols: 40, rows: 10 })
    await write(t, 'frame')
    expect(t.buffer.active.type).toBe('normal')
    expect(t.modes.mouseTrackingMode).toBe('none')
    t.dispose()
  })
})
