/**
 * The phone's hold-to-talk microphone (.ai/04-ui.md § From a phone, *The
 * bar*), as a pure state machine so its rules are tested apart from the
 * pointer events that drive it:
 *
 * - **Hold** to record; **release** sends.
 * - A **short tap** (under `TAP_MS`) latches: recording goes on, and the next
 *   tap sends.
 * - **Sliding off** the button while holding cancels: nothing is sent, and
 *   what was heard stays in the field. A latched recording ignores it, since
 *   no finger is down.
 * - A **pointer cancel** (the browser taking the touch) latches: recording
 *   goes on, and the next tap sends.
 * - The keyboard (Space or Enter on the focused button) starts a latched
 *   recording and the next press sends.
 */

/** A press shorter than this is a tap, and latches. */
export const TAP_MS = 350

export type PttState =
  | { phase: 'idle' }
  | { phase: 'holding'; since: number }
  | { phase: 'latched' }

export type PttInput =
  | { type: 'down'; at: number }
  | { type: 'up'; at: number }
  | { type: 'leave' }
  | { type: 'cancel' }
  | { type: 'key' }

/** What the caller does after a step: start listening, send what was heard, or drop it. */
export type PttAction = 'start' | 'send' | 'cancel' | null

export const PTT_IDLE: PttState = { phase: 'idle' }

export function pttStep(s: PttState, i: PttInput): { state: PttState; action: PttAction } {
  switch (i.type) {
    case 'down':
      if (s.phase === 'idle') return { state: { phase: 'holding', since: i.at }, action: 'start' }
      return { state: s, action: null } // latched: the tap that sends is read on its release
    case 'up':
      if (s.phase === 'holding') {
        if (i.at - s.since < TAP_MS) return { state: { phase: 'latched' }, action: null }
        return { state: PTT_IDLE, action: 'send' }
      }
      if (s.phase === 'latched') return { state: PTT_IDLE, action: 'send' }
      return { state: s, action: null }
    case 'leave':
      if (s.phase === 'holding') return { state: PTT_IDLE, action: 'cancel' }
      return { state: s, action: null }
    case 'cancel':
      // The browser took the touch (a gesture, the keyboard, a system
      // sheet): the finger did not choose to stop, so the recording goes on
      // latched and the next tap sends it. Dropping it here lost what was
      // said (owner, 2026-10-19).
      if (s.phase === 'holding') return { state: { phase: 'latched' }, action: null }
      return { state: s, action: null }
    case 'key':
      if (s.phase === 'idle') return { state: { phase: 'latched' }, action: 'start' }
      return { state: PTT_IDLE, action: 'send' }
  }
}

/** How far outside the button a finger may drift before the press counts as slid off, in px. */
export const SLIDE_OFF_PX = 24

/** Whether a point is off a rectangle by more than the slop. */
export function slidOff(rect: { left: number; right: number; top: number; bottom: number }, x: number, y: number, slop = SLIDE_OFF_PX): boolean {
  return x < rect.left - slop || x > rect.right + slop || y < rect.top - slop || y > rect.bottom + slop
}
