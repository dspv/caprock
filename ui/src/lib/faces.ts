/**
 * Claude's faces (owner, 2026-10-14: "make at least 6–9 variants of this
 * little guy, just for fun, so you can change it and they get assigned,
 * e.g. randomly", translated). Eight looks of the same pebble construction
 * (components/Characters.tsx); a session gets one from a hash of its id, so
 * it keeps its face in the hero, on the Now screen and on a phone. A click
 * on the hero's portrait picks another for that session; Settings →
 * Appearance sets the default: a face per session at random (the default),
 * or one fixed face for every session.
 *
 * Kept per viewer, in this browser's storage. Storage that throws or holds
 * garbage reads as nothing chosen, so the hashed face still shows.
 */
import { useEffect, useState } from 'react'

export const FACES = ['cap', 'beanie', 'headphones', 'crown', 'wizard', 'tuft', 'bandana', 'propeller'] as const
export type Face = (typeof FACES)[number]
export type FaceDefault = 'random' | Face

export const FACE_NAME: Record<Face, string> = {
  cap: 'Hard hat',
  beanie: 'Beanie',
  headphones: 'Headphones',
  crown: 'Crown',
  wizard: 'Wizard',
  tuft: 'Tuft',
  bandana: 'Bandana',
  propeller: 'Propeller cap',
}

/** A session's own pick: `{ [session_id]: face }`. */
export const FACES_KEY = 'caprock.faces.sessions'
/** 'random', or the one face every session wears. */
export const FACE_DEFAULT_KEY = 'caprock.faces.default'
/** Said on window when a pick or the default changes, so every portrait agrees at once. */
export const FACES_EVENT = 'caprock:faces'
/** The most picks kept; the oldest goes first. */
export const MAX_PICKS = 300

export function isFace(v: unknown): v is Face {
  return typeof v === 'string' && (FACES as readonly string[]).includes(v)
}

/** FNV-1a over the id: the same session lands on the same face everywhere, on every device. */
export function hashedFace(sessionId: string): Face {
  let h = 0x811c9dc5
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return FACES[(h >>> 0) % FACES.length]!
}

function readPicks(): Record<string, Face> {
  try {
    const raw = JSON.parse(localStorage.getItem(FACES_KEY) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, Face> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (isFace(v)) out[k] = v
    return out
  } catch { return {} }
}

export function loadFaceDefault(): FaceDefault {
  try {
    const v = localStorage.getItem(FACE_DEFAULT_KEY)
    return isFace(v) ? v : 'random'
  } catch { return 'random' }
}

/** The face a session wears: its own pick, else the fixed default, else its hash. */
export function faceFor(sessionId: string | undefined): Face {
  const d = loadFaceDefault()
  if (!sessionId) return d === 'random' ? 'cap' : d
  const pick = readPicks()[sessionId]
  if (pick) return pick
  return d === 'random' ? hashedFace(sessionId) : d
}

/** Whether the session wears a face it was given by hand. */
export function hasOwnFace(sessionId: string): boolean {
  return sessionId in readPicks()
}

function say() {
  try { window.dispatchEvent(new CustomEvent(FACES_EVENT)) } catch { /* no window */ }
}

/** Gives a session a face; null puts it back on the default. */
export function setSessionFace(sessionId: string, face: Face | null) {
  const picks = readPicks()
  delete picks[sessionId]
  if (face) picks[sessionId] = face
  const keys = Object.keys(picks)
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PICKS))) delete picks[k]
  try { localStorage.setItem(FACES_KEY, JSON.stringify(picks)) } catch { /* for this page only */ }
  say()
}

export function saveFaceDefault(d: FaceDefault) {
  try { localStorage.setItem(FACE_DEFAULT_KEY, d) } catch { /* for this page only */ }
  say()
}

/** Re-renders on a change here or in another tab. */
function useFacesVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => {
    const bump = () => setV((n) => n + 1)
    const onStorage = (e: StorageEvent) => { if (e.key === FACES_KEY || e.key === FACE_DEFAULT_KEY) bump() }
    window.addEventListener(FACES_EVENT, bump)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(FACES_EVENT, bump)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return v
}

export function useSessionFace(sessionId: string | undefined): Face {
  useFacesVersion()
  return faceFor(sessionId)
}

export function useFaceDefault(): [FaceDefault, (d: FaceDefault) => void] {
  useFacesVersion()
  return [loadFaceDefault(), saveFaceDefault]
}
