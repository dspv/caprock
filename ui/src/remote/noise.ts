/**
 * The phone's half of the remote channel's handshake:
 * Noise_NK_25519_AESGCM_SHA256 (ADR-058).
 *
 * The daemon's half is internal/remote/noise.go. The two are held to the same
 * bytes by testdata/remote/noise-vector.json, which noise.test.ts reads — a
 * change to either side that the other does not make turns a test red.
 *
 * Synchronous on purpose (@noble rather than WebCrypto): every frame's nonce
 * is its position in the stream, and an await between "take the next nonce"
 * and "send" is a place for two frames to swap.
 */
import { x25519 } from '@noble/curves/ed25519.js'
import { gcm } from '@noble/ciphers/aes.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

const PROTOCOL = 'Noise_NK_25519_AESGCM_SHA256'
const PROLOGUE = 'caprock-remote-v1'
export const MAX_MESSAGE = 65535
const TAG = 16
export const MAX_PLAINTEXT = MAX_MESSAGE - TAG

const enc = new TextEncoder()

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const tmp = hmac(sha256, ck, ikm)
  const o1 = hmac(sha256, tmp, Uint8Array.of(1))
  const o2 = hmac(sha256, tmp, concat(o1, Uint8Array.of(2)))
  return [o1, o2]
}

/** AESGCM's nonce: four zero bytes, then the counter big-endian. */
function nonce(n: bigint): Uint8Array {
  const b = new Uint8Array(12)
  new DataView(b.buffer).setBigUint64(4, n, false)
  return b
}

class CipherState {
  private n = 0n
  constructor(private readonly k: Uint8Array) {}
  encrypt(ad: Uint8Array, pt: Uint8Array): Uint8Array {
    const out = gcm(this.k, nonce(this.n), ad).encrypt(pt)
    this.n++
    return out
  }
  decrypt(ad: Uint8Array, ct: Uint8Array): Uint8Array {
    // Throws when the tag does not verify; the counter only moves on success.
    const out = gcm(this.k, nonce(this.n), ad).decrypt(ct)
    this.n++
    return out
  }
}

class SymmetricState {
  ck: Uint8Array
  h: Uint8Array
  k: CipherState | null = null
  constructor() {
    const h = new Uint8Array(32)
    h.set(enc.encode(PROTOCOL))
    this.h = h
    this.ck = h.slice()
    this.mixHash(enc.encode(PROLOGUE))
  }
  mixHash(data: Uint8Array) {
    this.h = sha256(concat(this.h, data))
  }
  mixKey(ikm: Uint8Array) {
    const [ck, k] = hkdf2(this.ck, ikm)
    this.ck = ck
    this.k = new CipherState(k)
  }
  encryptAndHash(pt: Uint8Array): Uint8Array {
    const ct = this.k ? this.k.encrypt(this.h, pt) : pt
    this.mixHash(ct)
    return ct
  }
  decryptAndHash(ct: Uint8Array): Uint8Array {
    const pt = this.k ? this.k.decrypt(this.h, ct) : ct
    this.mixHash(ct)
    return pt
  }
  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.ck, new Uint8Array(0))
    return [new CipherState(k1), new CipherState(k2)]
  }
}

function dh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  const out = x25519.getSharedSecret(priv, pub)
  if (out.every((b) => b === 0)) throw new Error('noise: key agreement produced zero')
  return out
}

/** An established channel. */
export class Session {
  constructor(
    private readonly send: CipherState,
    private readonly recv: CipherState,
  ) {}
  encrypt(pt: Uint8Array): Uint8Array {
    if (pt.length > MAX_PLAINTEXT) throw new Error('noise: message too long')
    return this.send.encrypt(new Uint8Array(0), pt)
  }
  decrypt(ct: Uint8Array): Uint8Array {
    if (ct.length < TAG || ct.length > MAX_MESSAGE) throw new Error('noise: bad message length')
    return this.recv.decrypt(new Uint8Array(0), ct)
  }
}

/** The phone's side of NK, between its first message and the daemon's reply. */
export class Initiator {
  private constructor(
    private readonly s: SymmetricState,
    private readonly e: Uint8Array,
  ) {}

  /**
   * Starts a handshake with the daemon whose static key is rs, carrying
   * payload. `ephemeral` is for the test vector; leave it out.
   */
  static start(rs: Uint8Array, payload: Uint8Array, ephemeral?: Uint8Array): { init: Initiator; message: Uint8Array } {
    const e = ephemeral ?? x25519.utils.randomSecretKey()
    const s = new SymmetricState()
    s.mixHash(rs)
    const ePub = x25519.getPublicKey(e)
    s.mixHash(ePub)
    s.mixKey(dh(e, rs))
    const ct = s.encryptAndHash(payload)
    return { init: new Initiator(s, e), message: concat(ePub, ct) }
  }

  /**
   * Reads the daemon's reply: its payload and the session. A message that is
   * not the reply throws and leaves the initiator as it was, so the real
   * reply can still be read after it: a relay can hand a new phone a stray
   * frame meant for the phone before it (transport.ts).
   */
  finish(msg2: Uint8Array): { payload: Uint8Array; session: Session } {
    if (msg2.length < 32 + TAG) throw new Error('noise: message too short')
    // mixHash and mixKey replace these rather than change them in place.
    const { ck, h, k } = this.s
    try {
      const re = msg2.slice(0, 32)
      this.s.mixHash(re)
      this.s.mixKey(dh(this.e, re))
      const payload = this.s.decryptAndHash(msg2.slice(32))
      const [send, recv] = this.s.split()
      return { payload, session: new Session(send, recv) }
    } catch (e) {
      Object.assign(this.s, { ck, h, k })
      throw e
    }
  }
}

/**
 * The daemon's side, for the test vector only: the phone never answers a
 * handshake.
 */
export function respondForTest(
  staticPriv: Uint8Array,
  msg1: Uint8Array,
  reply: Uint8Array,
  ephemeral: Uint8Array,
): { message: Uint8Array; payload: Uint8Array; session: Session } {
  const s = new SymmetricState()
  s.mixHash(x25519.getPublicKey(staticPriv))
  const re = msg1.slice(0, 32)
  s.mixHash(re)
  s.mixKey(dh(staticPriv, re))
  const payload = s.decryptAndHash(msg1.slice(32))
  const ePub = x25519.getPublicKey(ephemeral)
  s.mixHash(ePub)
  s.mixKey(dh(ephemeral, re))
  const ct = s.encryptAndHash(reply)
  const [toResponder, toInitiator] = s.split()
  return { message: concat(ePub, ct), payload, session: new Session(toInitiator, toResponder) }
}
