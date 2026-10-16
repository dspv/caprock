/**
 * Second Brain (ADR-063; 03-contracts.md § Second Brain): a graph of what the
 * sessions did, decided and found. This file is the client's side of it:
 * the quick capture's event, dropping a note in, and hooks that keep a screen
 * current from the live socket (a `brain` frame on every change).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errText, type BrainAutoStatus, type BrainDrop, type BrainFilterQuery, type BrainGraph, type BrainKind, type BrainNode, type BrainStage, type BrainStatus } from './api'
import { fmtWhen } from './format'
import { live } from './live'
import { everyWhileVisible } from './visible'

/** Said on window to open the quick capture; `detail.text` prefills it. */
export const BRAIN_CAPTURE_EVENT = 'caprock:brain-capture'

/** The one line on what Second Brain is, under its name in the sidebar and
 *  on its screen. It said "your personal Jarvis" until the owner found that
 *  might not be quickly understood (2026-10-15). */
export const BRAIN_TAGLINE = 'Remembers what your agents learn — so the next one starts smarter.'

/** Opens the quick capture (⇧⌘H, ⌘K "Add to Second Brain…"), optionally with text in it. */
export function openBrainCapture(text?: string) {
  window.dispatchEvent(new CustomEvent(BRAIN_CAPTURE_EVENT, { detail: { text } }))
}

/** The four kinds of memory, as the capture offers them, with a word each. */
export const MEMORY_KINDS: { kind: BrainKind; label: string; hint: string }[] = [
  { kind: 'idea', label: 'Idea', hint: 'something to try' },
  { kind: 'decision', label: 'Decision', hint: 'what was chosen, and why' },
  { kind: 'finding', label: 'Finding', hint: 'what turned out to be true' },
  { kind: 'question', label: 'Question', hint: 'what is still open' },
]

/** Each kind's name, for a label. */
export const KIND_LABEL: Record<BrainKind, string> = {
  idea: 'Idea', decision: 'Decision', finding: 'Finding', question: 'Question', topic: 'Topic', person: 'Person', project: 'Project',
}

/** Whether a kind is an entity (topic, person, project) rather than a memory. */
export function isEntity(kind: BrainKind): boolean {
  return kind === 'topic' || kind === 'person' || kind === 'project'
}

/** Each kind's colour, as a CSS variable the theme defines (design/tokens.css). */
export const KIND_COLOR: Record<BrainKind, string> = {
  idea: 'var(--brain-idea)',
  decision: 'var(--brain-decision)',
  finding: 'var(--brain-finding)',
  question: 'var(--brain-question)',
  topic: 'var(--brain-topic)',
  person: 'var(--brain-person)',
  project: 'var(--brain-project)',
}

/** The outcome of a drop, in words for a button or a line. */
export type DropResult = { ok: true; node: BrainNode } | { ok: false; message: string }

/** Drops something into the brain. Second Brain has no cap (owner decision, 2026-10-14). */
export async function dropIntoBrain(d: BrainDrop): Promise<DropResult> {
  try {
    const r = await api.dropBrain(d)
    return { ok: true, node: r.node }
  } catch (e) {
    return { ok: false, message: errText(e) }
  }
}

/** Calls `fn` on every brain change the live socket reports, and after a replay gap; a read's `progress` frames only with `{progress: true}`. */
export function useBrainFrames(fn: (f?: { id: number; op: string; title?: string; kind?: string; auto?: boolean }) => void, opts?: { progress?: boolean }) {
  const progress = !!opts?.progress
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => live.onFrame((f) => {
    if (f.type === 'brain') {
      // A read beginning or ending changes no memory; only the status cares.
      if ((f.data as { op?: string } | undefined)?.op === 'progress' && !progress) return
      ref.current(f.data)
    } else if (f.type === 'reset') ref.current()
  }), [progress])
}

/** How often the status is read again while a build is going, on top of the frames. */
const BUILD_POLL_MS = 4000

/** Whether the extraction is working through sessions: on, and reading or with some waiting. */
export function isBuilding(auto: BrainAutoStatus | undefined): boolean {
  return !!auto?.on && auto.claude_found && (auto.running || !!auto.reading || auto.pending > 0)
}

/**
 * Second Brain's status, kept current: read again on every brain frame
 * (spaced, so eight memories landing read it once) and, while a build is
 * going, every few seconds too, so its clock and countdown move.
 */
export function useBrainStatus(): { status: BrainStatus | null; reload: () => void } {
  const [status, setStatus] = useState<BrainStatus | null>(null)
  const reload = useCallback(() => {
    api.brainStatus().then(setStatus, () => {})
  }, [])
  useEffect(reload, [reload])
  const timer = useRef<number | undefined>(undefined)
  useBrainFrames(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(reload, 150)
  }, { progress: true })
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const building = isBuilding(status?.auto)
  useEffect(() => {
    if (!building) return
    return everyWhileVisible(reload, BUILD_POLL_MS)
  }, [building, reload])
  return { status, reload }
}

/** What *Start building* reads first: the past month. */
export const BACKFILL_DAYS = 30

/**
 * One click: the yes (PUT /v1/brain/settings {auto: true}), then the past
 * month (POST /v1/brain/backfill {days: 30}). Turning on alone reads only
 * sessions that end after it; the line beside the button promises the last
 * 30 days, so the backfill follows at once. Nothing runs before this call.
 */
export async function startBuilding(): Promise<void> {
  await api.brainSettings({ auto: true })
  await api.brainBackfill(BACKFILL_DAYS, true)
}

/**
 * The graph for a filter, re-read when it changes on the daemon. Re-reads are
 * spaced (`gapMs`), so an extraction adding eight memories reads once.
 * `enabled` false reads nothing (a second read the screen needs only while
 * filtered).
 */
export function useBrainGraph(filter: BrainFilterQuery, gapMs = 400, enabled = true): { graph: BrainGraph | null; error: string; reload: () => void } {
  const [graph, setGraph] = useState<BrainGraph | null>(null)
  const [error, setError] = useState('')
  const key = enabled ? JSON.stringify(filter) : ''
  const seq = useRef(0)
  const reload = useCallback(() => {
    if (!key) return
    const n = ++seq.current
    api.brain(JSON.parse(key) as BrainFilterQuery).then(
      (g) => { if (n === seq.current) { setGraph(g); setError('') } },
      (e: unknown) => { if (n === seq.current) setError(errText(e)) },
    )
  }, [key])
  useEffect(reload, [reload])
  const timer = useRef<number | undefined>(undefined)
  useBrainFrames(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(reload, gapMs)
  })
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return { graph, error, reload }
}

/** 100k, 300k, 1M: a token count as people say a limit. */
export function tokensShort(v: number): string {
  if (v >= 1_000_000 && v % 1_000_000 === 0) return `${v / 1_000_000}M`
  if (v >= 1000) return `${Math.round(v / 1000)}k`
  return String(v)
}

/**
 * The one line beside *Start building* that says what it does (rule 4; the
 * rest is under Details): whose model, what, where, how much, and that
 * nothing goes to Caprock. The cap is the daemon's, as the status says it.
 */
export function startLine(dailyTokens: number): string {
  return `Your own Claude reads your last ${BACKFILL_DAYS} days of sessions on this computer · up to ${tokensShort(dailyTokens)} tokens a day · nothing goes to Caprock`
}

/** A build in figures: read of all, the days it reaches back (0 when it reads only from the yes), and the share done. */
export function buildFigures(auto: BrainAutoStatus | undefined, now = Date.now()) {
  const b = auto?.build
  if (!b) return null
  const reach = auto?.backfill_since && auto.backfill_since <= b.from + 1000
  const days = reach ? Math.max(1, Math.round((now - b.from) / 86_400_000)) : 0
  const share = b.sessions > 0 ? Math.min(1, b.read / b.sessions) : 1
  return { ...b, days, share }
}

/** How many memories have been added since the caller mounted, from the live socket: the orb sends a spark for each. */
export function useBrainLanded(): number {
  const [n, setN] = useState(0)
  useBrainFrames((f) => { if (f?.op === 'added') setN((v) => v + 1) })
  return n
}

/** How busy the extraction is, for the orb's sparks: 0 idle, 1 with sessions waiting, 2 while one is read. */
export function brainActivity(auto: BrainAutoStatus | undefined): number {
  if (!isBuilding(auto)) return 0
  return auto?.reading ? 2 : 1
}

/**
 * What Second Brain is doing, in words, and a figure or two: the sidebar
 * card's line. What it does now comes first (owner, 2026-10-15: "what it is
 * doing right now matters more than the numbers"), so while it works the
 * figure shrinks to the count and the mode keeps the room.
 */
export function brainMode(status: BrainStatus | null, today = 0): { mode: string; metric: string; active: boolean } {
  const n = status?.memories ?? 0
  const count = `${n} ${n === 1 ? 'memory' : 'memories'}`
  const metric = n > 0 ? (today > 0 ? `${n} · +${today} today` : count) : ''
  const auto = status?.auto
  if (!auto) return { mode: n > 0 ? 'Kept by hand' : 'Not started', metric, active: false }
  if (!auto.on) return { mode: auto.chosen ? 'Paused' : 'Not started', metric, active: false }
  if (!auto.claude_found) return { mode: 'Needs Claude Code', metric, active: false }
  if (auto.reading) {
    const verb = auto.reading.phase === 'linking' ? 'Linking' : 'Reading'
    return { mode: auto.reading.project ? `${verb} ${auto.reading.project}` : `${verb} a session`, metric: n > 0 ? String(n) : '', active: true }
  }
  if (auto.daily_tokens > 0 && auto.spent >= auto.daily_tokens) return { mode: 'Today’s limit reached', metric, active: false }
  if (auto.pending > 0) return { mode: `${auto.pending} session${auto.pending === 1 ? '' : 's'} to read`, metric: n > 0 ? String(n) : '', active: true }
  return { mode: 'Up to date', metric, active: false }
}

/** Where a build is: the daemon's `stage`, or the same worked out from an older daemon's status. */
export function brainStage(auto: BrainAutoStatus | undefined): BrainStage {
  if (!auto || !auto.on) return 'off'
  if (auto.stage) return auto.stage
  if (auto.reading) return auto.reading.phase === 'linking' ? 'linking' : 'extracting'
  if (!auto.claude_found) return 'no_claude'
  if (auto.pending > 0 && auto.spent >= auto.daily_tokens) return 'limit'
  return auto.pending > 0 ? 'waiting' : 'up_to_date'
}

/** A clock time today ("14:02"), else the day and time ("12 Oct 14:02"). */
export function clockOrDay(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  if (d.toDateString() === new Date(now).toDateString()) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return fmtWhen(ms, now)
}

/**
 * The build's state as one line (the screen's strip and the sidebar card):
 * a word, what it means now, and how far it is — every figure from the
 * status, none made up. `share` is the sessions read of all in reach while
 * it builds, else null (no bar). `n of m` is the session being read, or the
 * sessions read when between reads.
 */
export function brainState(auto: BrainAutoStatus | undefined, now = Date.now()): {
  stage: BrainStage; word: string; detail: string; tone: 'active' | 'calm' | 'off' | 'warn'; share: number | null; n: number; m: number
} {
  const stage = brainStage(auto)
  const b = auto?.build
  const m = b?.sessions ?? 0
  const read = b?.read ?? 0
  const n = auto?.reading ? Math.min(read + 1, Math.max(m, 1)) : read
  const share = m > 0 ? Math.min(1, read / m) : null
  const of = m > 0 ? `${n} of ${m}${b?.truncated ? '+' : ''}` : ''
  switch (stage) {
    case 'off':
      return auto?.chosen
        ? { stage, word: 'Paused', detail: 'you paused it — nothing new is read until you resume', tone: 'off', share: null, n, m }
        : { stage, word: 'Off', detail: 'not started — nothing is read until you start it', tone: 'off', share: null, n, m }
    case 'no_claude':
      return { stage, word: 'Stopped', detail: 'Claude Code was not found on this computer, so nothing can be read', tone: 'warn', share: null, n, m }
    case 'limit':
      return { stage, word: 'Waiting', detail: `today’s ${tokensShort(auto?.daily_tokens ?? 0)} tokens are used; it goes on as the day rolls over${of ? ` · ${read} of ${m} read` : ''}`, tone: 'warn', share, n, m }
    case 'extracting':
      return { stage, word: 'Building', detail: of ? `reading session ${of}` : 'reading a session', tone: 'active', share, n, m }
    case 'linking':
      return { stage, word: 'Building', detail: of ? `linking what session ${n} of ${m} gave` : 'linking what a session gave', tone: 'active', share, n, m }
    case 'waiting': {
      const next = auto?.next_wake && auto.next_wake > now ? Math.ceil((auto.next_wake - now) / 1000) : 0
      const when = next > 0 && next < 600 ? (next > 90 ? `next in ${Math.round(next / 60)} min` : `next in ${next}s`) : 'opening the next session'
      return { stage, word: 'Building', detail: `${of ? `${read} of ${m} read · ` : ''}${when}`, tone: 'active', share, n, m }
    }
    default:
      return { stage, word: 'Up to date', detail: auto?.last_read ? `last built ${clockOrDay(auto.last_read, now)}` : 'nothing read yet — a session is read 10 minutes after it goes quiet', tone: 'calm', share: null, n, m }
  }
}

/** The steps one read goes through, in order, as the strip shows them. */
export const BRAIN_STEPS: { stage: 'find' | 'extracting' | 'linking'; label: string }[] = [
  { stage: 'find', label: 'Find finished sessions' },
  { stage: 'extracting', label: 'Claude extracts memories' },
  { stage: 'linking', label: 'Link into the graph' },
]
