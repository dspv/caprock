/**
 * The pairing, kept in the iOS Keychain (ADR-083).
 *
 * The phone's page keeps its machines and device token in `localStorage`
 * (remote/boot.ts), and the dashboard reads the token from there. In the app
 * that storage is the WebView's, which iOS may clear under storage pressure,
 * so the Keychain holds the durable copy: written whenever the page's copy
 * changes, read back before the page starts when the page's copy is gone.
 * Items are this device only (never in a backup restored elsewhere, never in
 * iCloud Keychain) and readable only while the phone is unlocked.
 *
 * Also kept here: whether the app locks behind Face ID, so a cleared WebView
 * cannot quietly turn the lock off.
 */
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage'

/** What the page stores about its machines (remote/boot.ts keys). */
export const PAIRING_KEYS = ['caprock.remote.machines', 'caprock.remote.current', 'caprock.device.token'] as const

const PAIRING_ITEM = 'pairing'
const LOCK_ITEM = 'lock'

let ready: Promise<void> | null = null

function setup(): Promise<void> {
  ready ??= (async () => {
    await SecureStorage.setKeyPrefix('caprock.ios.')
    await SecureStorage.setSynchronize(false)
    await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly)
  })().catch(() => { ready = null })
  return ready ?? Promise.resolve()
}

function snapshot(store: Storage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of PAIRING_KEYS) {
    const v = store.getItem(k)
    if (v) out[k] = v
  }
  return out
}

/**
 * Before the page starts: when the page's copy has no machines and the
 * Keychain has some, put them back. The page's copy wins whenever it has
 * any — a pairing link writes there first and reloads.
 */
export async function restorePairing(store: Storage = localStorage): Promise<boolean> {
  try {
    if (store.getItem('caprock.remote.machines')) return false
    await setup()
    const saved = await SecureStorage.get(PAIRING_ITEM)
    if (!saved || typeof saved !== 'object') return false
    let restored = false
    for (const k of PAIRING_KEYS) {
      const v = (saved as Record<string, unknown>)[k]
      if (typeof v === 'string' && v) {
        store.setItem(k, v)
        restored = true
      }
    }
    return restored
  } catch {
    return false
  }
}

/** Writes the page's copy to the Keychain; with no machine left, removes it. */
export async function keepPairing(store: Storage = localStorage): Promise<void> {
  try {
    await setup()
    const snap = snapshot(store)
    if (!snap['caprock.remote.machines'] || snap['caprock.remote.machines'] === '[]') {
      await SecureStorage.remove(PAIRING_ITEM)
      return
    }
    await SecureStorage.set(PAIRING_ITEM, snap)
  } catch { /* the page's copy still works; the next change tries again */ }
}

/** Unpair: the Keychain copy goes with the page's. */
export async function wipePairing(): Promise<void> {
  try {
    await setup()
    await SecureStorage.remove(PAIRING_ITEM)
  } catch { /* nothing stored */ }
}

export async function lockWanted(): Promise<boolean> {
  try {
    await setup()
    return (await SecureStorage.get(LOCK_ITEM)) === true
  } catch {
    return false
  }
}

export async function setLockWanted(on: boolean): Promise<void> {
  await setup()
  if (on) await SecureStorage.set(LOCK_ITEM, true)
  else await SecureStorage.remove(LOCK_ITEM)
}
