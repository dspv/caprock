/**
 * The optional Face ID lock in front of the app (ADR-083), with the iPhone
 * passcode as the fallback. The lock hides the screen only: the channel to
 * the computer, and every session on it, keep running behind it.
 */
import { BiometricAuth, BiometryType } from '@aparajita/capacitor-biometric-auth'

export interface LockKind {
  /** Whether this iPhone can lock the app at all: biometry, or at least a passcode. */
  available: boolean
  /** What the switch and the button are called: Face ID, Touch ID, or Passcode. */
  name: string
  /** Why the lock is not available, in a sentence; '' when it is. */
  why: string
}

export async function lockKind(): Promise<LockKind> {
  try {
    const r = await BiometricAuth.checkBiometry()
    const name = r.biometryType === BiometryType.faceId ? 'Face ID' : r.biometryType === BiometryType.touchId ? 'Touch ID' : 'Passcode'
    if (r.isAvailable || r.deviceIsSecure) return { available: true, name: r.isAvailable ? name : 'Passcode', why: '' }
    return { available: false, name, why: 'Set a passcode on this iPhone first: Settings → Face ID & Passcode.' }
  } catch {
    return { available: false, name: 'Face ID', why: 'This iPhone did not say whether it can lock apps.' }
  }
}

/** Asks for Face ID (or the passcode). True when the person is let in. */
export async function unlock(reason = 'Unlock Caprock'): Promise<boolean> {
  try {
    await BiometricAuth.authenticate({ reason, cancelTitle: 'Cancel', allowDeviceCredential: true, iosFallbackTitle: 'Use passcode' })
    return true
  } catch {
    return false
  }
}
