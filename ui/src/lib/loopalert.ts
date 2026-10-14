/**
 * The loop alert's words and the two ways of putting one away.
 *
 * The card used to read "Stuck in a loop · caprock · ran Bash: python3
 * /private/tmp/…/p2e.py 5× in 3 min · $0.88 in context · $1,886.75 session
 * total · 58m ago · open · this is what a cap stops · a cap that stops this ·
 * × · dismiss", and the owner's verdict (2026-10-14, translated) was: "it's
 * unclear what to do — many buttons, zero meaning. What does it suggest?" So
 * the card now says one plain sentence of what happened and offers three
 * things to do about it, the first being to tell the agent — through the
 * session's own message queue, on a session Caprock started (rule 7).
 *
 * Everything here is pure or a small store, so the sentence, the message the
 * agent receives and the mute are unit-tested apart from the card.
 */
import { useSyncExternalStore } from 'react'
import type { LoopAlert } from './api'

/** The repeated input without the detector's "Tool: " prefix. */
export function loopInput(a: Pick<LoopAlert, 'tool' | 'sample'>): string {
  const s = (a.sample ?? '').trim()
  if (!s) return ''
  const p = a.tool ? `${a.tool}: ` : ''
  if (p && s.startsWith(p)) return s.slice(p.length).trim()
  // A bare tool name is what the detector sends when there was no input.
  return s === a.tool ? '' : s
}

const SHELL = new Set(['Bash', 'exec', 'shell', 'local_shell', 'exec_command'])

/** What kind of repetition it was, in words: "the same command", "the same file". */
export function loopWhat(tool: string): { verb: string; noun: string } {
  if (SHELL.has(tool) || !tool) return { verb: 'ran', noun: 'the same command' }
  switch (tool) {
    case 'Read': return { verb: 'read', noun: 'the same file' }
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return { verb: 'edited', noun: 'the same file' }
    case 'Grep': case 'Glob': return { verb: 'ran', noun: 'the same search' }
    case 'WebFetch': return { verb: 'fetched', noun: 'the same page' }
    case 'WebSearch': return { verb: 'ran', noun: 'the same web search' }
    default: return { verb: 'made', noun: `the same ${tool} call` }
  }
}

/** What the mute item names: "this command" for a shell, else "this call". */
export function muteNoun(tool: string): string {
  return SHELL.has(tool) || !tool ? 'this command' : 'this call'
}

/**
 * The input shortened for a sentence: an absolute path keeps only its last
 * segment ("python3 /private/tmp/…/brain/p2e.py" → "python3 …/p2e.py"), and
 * what is still too long is clipped. The whole input is on hover.
 */
export function shortInput(input: string, max = 48): string {
  const words = input.split(/(\s+)/).map((w) => {
    const m = /^(['"]?)(~?\/[^\s'"]*\/)([^/\s'"]+)(['"]?)$/.exec(w)
    // Only a path two or more folders deep is worth eliding.
    if (!m || (m[2]!.match(/\//g) ?? []).length < 3) return w
    return `${m[1]}…/${m[3]}${m[4]}`
  })
  const s = words.join('')
  const chars = Array.from(s)
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : s
}

/**
 * How long the repetition took: the span between its first and last call,
 * rounded up, else the detector's window. "5 times in 3 minutes" with a
 * three-minute window and a 40-second burst would overstate it.
 */
export function loopSpan(a: Pick<LoopAlert, 'first_ts' | 'last_ts' | 'ts' | 'window_min'>): string {
  const first = Date.parse(a.first_ts ?? '')
  const last = Date.parse(a.last_ts || a.ts || '')
  if (Number.isFinite(first) && Number.isFinite(last) && last >= first) {
    const sec = Math.round((last - first) / 1000)
    if (sec < 60) return sec <= 1 ? 'a second' : `${sec} seconds`
    const min = Math.ceil(sec / 60)
    if (!Number.isFinite(a.window_min) || min <= Math.max(a.window_min, 1)) return min === 1 ? '1 minute' : `${min} minutes`
  }
  if (Number.isFinite(a.window_min) && a.window_min > 0) return a.window_min === 1 ? '1 minute' : `${a.window_min} minutes`
  return ''
}

function times(n: number): string {
  if (!Number.isFinite(n)) return 'over and over'
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`
}

/**
 * The card's sentence: "caprock ran the same command 5 times in 3 minutes".
 * The input itself goes beside it, shortened, so the parts are returned apart.
 */
export function loopHeadline(project: string, a: LoopAlert): { sentence: string; input: string; short: string } {
  const { verb, noun } = loopWhat(a.tool)
  const span = loopSpan(a)
  const who = project || 'This session'
  const sentence = `${who} ${verb} ${noun} ${times(a.count)}${span ? ` in ${span}` : ''}`
  const input = loopInput(a)
  return { sentence, input, short: input ? shortInput(input) : '' }
}

/**
 * The message "Tell the agent" queues into the session. One line — a newline
 * typed into a terminal prompt submits what came before it — and plainly not
 * the user's own words: it opens with [Caprock] and ends by saying who sent it,
 * so the agent does not take a heads-up for an instruction from the person.
 *
 * The input goes in whole (the detector already clips it to 120 characters):
 * the agent recognises the exact command it ran, not a shortened one.
 */
export function tellAgentMessage(a: LoopAlert): string {
  const { verb, noun } = loopWhat(a.tool)
  const span = loopSpan(a)
  const input = loopInput(a).replace(/\s+/g, ' ')
  const when = span ? `in the last ${span} ` : ''
  return `[Caprock] Heads-up: ${when}you ${verb} ${noun} ${times(a.count)}${input ? `: \`${input.replace(/`/g, "'")}\`` : ''}. `
    + `If you're stuck, step back and try a different approach, or tell me what's blocking. `
    + `(Sent by Caprock's loop alert — not by the user.)`
}

// --- Dismiss and mute ------------------------------------------------------
//
// Dismiss puts away this alert; it comes back if the detector fires again
// later. Mute is "don't warn about this command again in this session": kept
// in this browser (a per-viewer convenience, like a folded panel), keyed by
// session and the repeated input, and it also outlives a reload.

const MUTE_KEY = 'caprock.loop.mute'
const MAX_MUTES = 200

let dismissed = new Set<string>()
let muted: string[] = readMutes()
let version = 0
const subs = new Set<() => void>()

function readMutes(): string[] {
  try {
    const raw = localStorage.getItem(MUTE_KEY)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function emit() {
  version++
  subs.forEach((f) => f())
}

const muteKey = (a: Pick<LoopAlert, 'session_id' | 'sample'>) => `${a.session_id}\u0000${a.sample ?? ''}`
// One episode: the session and when it was raised. A new alert later in the
// same session is a new episode and shows again.
const episodeKey = (a: Pick<LoopAlert, 'session_id' | 'ts'>) => `${a.session_id}\u0000${a.ts ?? ''}`

/** Put this alert away until the detector raises a new one. */
export function dismissLoop(a: LoopAlert) {
  dismissed = new Set(dismissed).add(episodeKey(a))
  emit()
}

/** Never warn about this input in this session again (in this browser). */
export function muteLoop(a: LoopAlert) {
  const k = muteKey(a)
  if (!muted.includes(k)) muted = [...muted, k].slice(-MAX_MUTES)
  try { localStorage.setItem(MUTE_KEY, JSON.stringify(muted)) } catch { /* private window: this page only */ }
  emit()
}

/** Whether the card should stay hidden. */
export function loopHidden(a: LoopAlert): boolean {
  return dismissed.has(episodeKey(a)) || muted.includes(muteKey(a))
}

/** Re-renders when an alert is dismissed or muted; returns the check. */
export function useLoopHidden(): (a: LoopAlert) => boolean {
  useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => version)
  return loopHidden
}

export function resetLoopMutesForTest() {
  dismissed = new Set()
  muted = readMutes()
  emit()
}
