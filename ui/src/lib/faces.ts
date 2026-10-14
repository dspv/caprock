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
 * Rubber ducks (owner, 2026-10-14: "a whole series of rubber ducks that sit
 * next to you; it's basically a programmer thing", translated) are faces
 * too, in a group of their own. They join the random pool only when the
 * default says so: FACES keeps its eight, in their order, so the hash still
 * lands every session on the face it had before the ducks came.
 *
 * Kept per viewer, in this browser's storage. Storage that throws or holds
 * garbage reads as nothing chosen, so the hashed face still shows.
 */
import { useEffect, useState } from 'react'

/** Claude's faces, and the default random pool: never reorder or extend, or every hashed session changes face. */
export const FACES = ['cap', 'beanie', 'headphones', 'crown', 'wizard', 'tuft', 'bandana', 'propeller'] as const
/** The rubber ducks: a group of their own, and a pool only when the default asks for one. */
export const DUCKS = ['duck', 'duck-glasses', 'duck-headset', 'duck-party', 'duck-pirate', 'duck-hoodie', 'duck-sleepy', 'duck-rainbow'] as const
export const ALL_FACES = [...FACES, ...DUCKS] as const
export type ClaudeFace = (typeof FACES)[number]
export type Duck = (typeof DUCKS)[number]
export type Face = ClaudeFace | Duck
/** A random pool — faces only (the default), ducks only, or both — or one fixed face for all. */
export type FacePool = 'random' | 'random-ducks' | 'random-all'
export type FaceDefault = FacePool | Face
export const FACE_POOLS: readonly FacePool[] = ['random', 'random-ducks', 'random-all']

export const FACE_NAME: Record<Face, string> = {
  cap: 'Hard hat',
  beanie: 'Beanie',
  headphones: 'Headphones',
  crown: 'Crown',
  wizard: 'Wizard',
  tuft: 'Tuft',
  bandana: 'Bandana',
  propeller: 'Propeller cap',
  duck: 'Rubber duck',
  'duck-glasses': 'Debugger duck',
  'duck-headset': 'On-call duck',
  'duck-party': 'Party duck',
  'duck-pirate': 'Pirate duck',
  'duck-hoodie': 'Hacker duck',
  'duck-sleepy': 'Sleepy duck',
  'duck-rainbow': 'Rainbow duck',
}

export const POOL_NAME: Record<FacePool, string> = {
  random: 'A face per session',
  'random-ducks': 'A duck per session',
  'random-all': 'Faces and ducks',
}

/** A session's own pick: `{ [session_id]: face }`. */
export const FACES_KEY = 'caprock.faces.sessions'
/** 'random' (or another pool), or the one face every session wears. */
export const FACE_DEFAULT_KEY = 'caprock.faces.default'
/** Said on window when a pick or the default changes, so every portrait agrees at once. */
export const FACES_EVENT = 'caprock:faces'
/** The most picks kept; the oldest goes first. */
export const MAX_PICKS = 300

export function isFace(v: unknown): v is Face {
  return typeof v === 'string' && (ALL_FACES as readonly string[]).includes(v)
}

export function isDuck(v: unknown): v is Duck {
  return typeof v === 'string' && (DUCKS as readonly string[]).includes(v)
}

export function isPool(v: unknown): v is FacePool {
  return typeof v === 'string' && (FACE_POOLS as readonly string[]).includes(v)
}

function poolOf(pool: FacePool): readonly Face[] {
  return pool === 'random-ducks' ? DUCKS : pool === 'random-all' ? ALL_FACES : FACES
}

/**
 * FNV-1a over the id: the same session lands on the same face everywhere, on
 * every device. The default pool is the eight faces and only them, so the
 * ducks moved nobody.
 */
export function hashedFace(sessionId: string, pool: FacePool = 'random'): Face {
  let h = 0x811c9dc5
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const faces = poolOf(pool)
  return faces[(h >>> 0) % faces.length]!
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
    return isFace(v) || isPool(v) ? v : 'random'
  } catch { return 'random' }
}

/** The face a session wears: its own pick, else the fixed default, else its hash in the default's pool. */
export function faceFor(sessionId: string | undefined): Face {
  const d = loadFaceDefault()
  if (!sessionId) return isPool(d) ? (d === 'random-ducks' ? 'duck' : 'cap') : d
  const pick = readPicks()[sessionId]
  if (pick) return pick
  return isPool(d) ? hashedFace(sessionId, d) : d
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

/**
 * The cockpit's "try a duck?" line (owner, 2026-10-14). It shows at most
 * once a day, and never again once the duck panel has been opened or the
 * line closed twice. Per viewer; storage that throws or holds garbage reads
 * as "already done", so a broken store never nags.
 */
export const DUCK_HINT_KEY = 'caprock.faces.duckHint'
export const DUCK_HINT_EVERY = 24 * 60 * 60 * 1000
/** Closes asked for before the line stops for good. */
export const DUCK_HINT_CLOSES = 2

type DuckHint = { shown: number; closed: number; done: boolean }

function readDuckHint(): DuckHint {
  try {
    const raw = localStorage.getItem(DUCK_HINT_KEY)
    if (raw === null) return { shown: 0, closed: 0, done: false }
    const v = JSON.parse(raw) as Partial<DuckHint> | null
    if (!v || typeof v !== 'object') return { shown: 0, closed: 0, done: true }
    return {
      shown: typeof v.shown === 'number' ? v.shown : 0,
      closed: typeof v.closed === 'number' ? v.closed : 0,
      done: v.done === true,
    }
  } catch { return { shown: 0, closed: 0, done: true } }
}

function writeDuckHint(h: DuckHint) {
  try { localStorage.setItem(DUCK_HINT_KEY, JSON.stringify(h)) } catch { /* for this page only */ }
}

/** Whether the line may show now: not done, closed fewer than twice, not shown in the last day. */
export function duckHintDue(now: number): boolean {
  const h = readDuckHint()
  return !h.done && h.closed < DUCK_HINT_CLOSES && now - h.shown >= DUCK_HINT_EVERY
}

/** The line went up: the day's one showing is spent. */
export function duckHintShown(now: number) {
  writeDuckHint({ ...readDuckHint(), shown: now })
}

/** × on the line: twice and it is gone for good. */
export function duckHintClosed() {
  const h = readDuckHint()
  writeDuckHint({ ...h, closed: h.closed + 1 })
}

/** The ducks were found (the panel opened on them, or one picked): the line never shows again. */
export function duckHintDone() {
  const h = readDuckHint()
  if (!h.done) writeDuckHint({ ...h, done: true })
}
