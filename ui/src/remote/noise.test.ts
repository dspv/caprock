import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Initiator, respondForTest } from './noise'

// The same file internal/remote/vector_test.go writes and checks: one
// handshake and two messages each way, byte for byte.
const v = JSON.parse(readFileSync(resolve(__dirname, '../../../testdata/remote/noise-vector.json'), 'utf8')) as {
  protocol: string
  responder_static: string
  responder_public: string
  initiator_ephemeral: string
  responder_ephemeral: string
  payload1: string
  payload2: string
  message1: string
  message2: string
  initiator_sends: string[]
  initiator_ciphertexts: string[]
  responder_sends: string[]
  responder_ciphertexts: string[]
}

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

describe('Noise NK, against the Go side', () => {
  it('writes the same first message and reads the same reply', () => {
    const { init, message } = Initiator.start(hex(v.responder_public), hex(v.payload1), hex(v.initiator_ephemeral))
    expect(toHex(message)).toBe(v.message1)
    const { payload, session } = init.finish(hex(v.message2))
    expect(toHex(payload)).toBe(v.payload2)
    v.initiator_sends.forEach((pt, i) => expect(toHex(session.encrypt(hex(pt)))).toBe(v.initiator_ciphertexts[i]!))
    v.responder_ciphertexts.forEach((ct, i) => expect(toHex(session.decrypt(hex(ct)))).toBe(v.responder_sends[i]!))
  })

  it('answers the same way the daemon does', () => {
    const r = respondForTest(hex(v.responder_static), hex(v.message1), hex(v.payload2), hex(v.responder_ephemeral))
    expect(toHex(r.message)).toBe(v.message2)
    expect(toHex(r.payload)).toBe(v.payload1)
  })

  it('refuses a message that was altered', () => {
    const { init } = Initiator.start(hex(v.responder_public), hex(v.payload1), hex(v.initiator_ephemeral))
    const { session } = init.finish(hex(v.message2))
    const bad = hex(v.responder_ciphertexts[0]!)
    bad[bad.length - 1]! ^= 1
    expect(() => session.decrypt(bad)).toThrow()
  })

  it('still reads the reply after a stray message', () => {
    // A frame meant for the phone before this one, then the machine's reply.
    const { init } = Initiator.start(hex(v.responder_public), hex(v.payload1), hex(v.initiator_ephemeral))
    expect(() => init.finish(hex(v.responder_ciphertexts[0]!.repeat(4)))).toThrow()
    expect(() => init.finish(new Uint8Array(64).fill(7))).toThrow()
    const { payload, session } = init.finish(hex(v.message2))
    expect(toHex(payload)).toBe(v.payload2)
    expect(toHex(session.decrypt(hex(v.responder_ciphertexts[0]!)))).toBe(v.responder_sends[0]!)
  })

  it('cannot finish against a different machine', () => {
    const other = hex('ab'.repeat(32))
    const { init } = Initiator.start(other, hex(v.payload1))
    expect(() => init.finish(hex(v.message2))).toThrow()
  })
})
