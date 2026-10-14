/**
 * Second Brain (ADR-063; 03-contracts.md § Second Brain): a graph of what the
 * sessions did, decided and found. This file is the client's side of it:
 * the quick capture's event, dropping a note in, and hooks that keep a screen
 * current from the live socket (a `brain` frame on every change).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errText, type BrainDrop, type BrainFilterQuery, type BrainGraph, type BrainKind, type BrainNode, type BrainStatus } from './api'
import { live } from './live'

/** Said on window to open the quick capture; `detail.text` prefills it. */
export const BRAIN_CAPTURE_EVENT = 'caprock:brain-capture'

/** Opens the quick capture (⇧⌘H, ⌘K "Add to brain…"), optionally with text in it. */
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

/** Calls `fn` on every brain change the live socket reports, and after a replay gap. */
export function useBrainFrames(fn: (f?: { id: number; op: string; title?: string; kind?: string; auto?: boolean }) => void) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => live.onFrame((f) => {
    if (f.type === 'brain') ref.current(f.data)
    else if (f.type === 'reset') ref.current()
  }), [])
}

/** Second Brain's status, kept current. */
export function useBrainStatus(): { status: BrainStatus | null; reload: () => void } {
  const [status, setStatus] = useState<BrainStatus | null>(null)
  const reload = useCallback(() => {
    api.brainStatus().then(setStatus, () => {})
  }, [])
  useEffect(reload, [reload])
  useBrainFrames(reload)
  return { status, reload }
}

/**
 * The graph for a filter, re-read when it changes on the daemon. Re-reads are
 * spaced (`gapMs`), so an extraction adding eight memories reads once.
 */
export function useBrainGraph(filter: BrainFilterQuery, gapMs = 400): { graph: BrainGraph | null; error: string; reload: () => void } {
  const [graph, setGraph] = useState<BrainGraph | null>(null)
  const [error, setError] = useState('')
  const key = JSON.stringify(filter)
  const seq = useRef(0)
  const reload = useCallback(() => {
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
