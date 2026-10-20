import { describe, expect, it, vi } from 'vitest'
import { contextGone, watchContextLoss } from './termgl'

const addon = (lost: boolean | (() => boolean) = false) => ({
  _renderer: {
    _gl: { isContextLost: typeof lost === 'function' ? lost : () => lost },
    _canvas: document.createElement('canvas'),
  },
})

describe('termgl', () => {
  it('says a context is gone only when the addon\'s own context says so', () => {
    expect(contextGone(addon(true))).toBe(true)
    expect(contextGone(addon(false))).toBe(false)
    // Another addon version, or no addon: it cannot tell, so it does not claim.
    expect(contextGone({})).toBe(false)
    expect(contextGone(undefined)).toBe(false)
    expect(contextGone(addon(() => { throw new Error('gone') }))).toBe(false)
  })

  it('hears the loss on the canvas at once, once, and stops when asked', () => {
    const a = addon()
    const lost = vi.fn()
    const stop = watchContextLoss(a, lost)
    a._renderer._canvas.dispatchEvent(new Event('webglcontextlost'))
    a._renderer._canvas.dispatchEvent(new Event('webglcontextlost'))
    expect(lost).toHaveBeenCalledTimes(1)
    stop()
    const b = addon()
    const lostB = vi.fn()
    watchContextLoss(b, lostB)()
    b._renderer._canvas.dispatchEvent(new Event('webglcontextlost'))
    expect(lostB).not.toHaveBeenCalled()
  })

  it('watches nothing on an addon whose canvas it cannot find', () => {
    const lost = vi.fn()
    expect(() => watchContextLoss({}, lost)()).not.toThrow()
    expect(lost).not.toHaveBeenCalled()
  })

  // The installed addon still keeps its context and canvas where these look:
  // an upgrade that moves them would leave only the addon's late report.
  it('the installed WebGL addon has the insides it reads', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(process.cwd(), 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs'), 'utf8')
    expect(src).toContain('this._gl=this._canvas.getContext("webgl2"')
    expect(src).toContain('this._renderer=this._register(')
  })
})
