/**
 * A session's name: the one the user gave it, else a short one Caprock makes
 * from what it already holds (owner, 2026-10-13: "I want to clearly
 * understand what the session is about: either I grasp it in two or three
 * words, or I rename it", translated).
 *
 * Renaming is shown at once: the held session list is patched before the
 * daemon answers (lib/useWorkspaceData.ts listens here), and the daemon's
 * session frame carries the name to every other window.
 */
import { api, type SessionSummary } from './api'

type Listener = (id: string, name: string) => void
const listeners = new Set<Listener>()

/** Called with every rename, before the daemon has answered. */
export function onSessionRenamed(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Rename a session; '' gives it back the name it had. Rolled back on failure. */
export async function renameSession(id: string, name: string, previous = ''): Promise<void> {
  const next = name.replace(/\s+/g, ' ').trim()
  if (next === previous.trim()) return
  for (const fn of listeners) fn(id, next)
  try {
    await api.renameSession(id, next)
  } catch (e) {
    for (const fn of listeners) fn(id, previous)
    throw e
  }
}

/** Whether a tab or row names a session the user may rename: an agent's, not a shell's or a file's. */
export function renamable(s: SessionSummary | undefined, isShell = false): s is SessionSummary {
  return !!s && !isShell && s.kind !== 'shell'
}

/** Words that open a request without saying what it is about. */
const OPENERS = new Set([
  'please', 'pls', 'plz', 'hey', 'hi', 'hello', 'ok', 'okay', 'so', 'now', 'just', 'also', 'and', 'then', 'well',
  'can', 'could', 'would', 'will', 'you', 'u', 'we', 'i', "i'd", "i'm", 'im', 'id', "let's", 'lets', 'let', 'us', 'me',
  'want', 'need', 'like', 'to', 'help', 'try', 'should', 'maybe', 'quickly', 'kindly',
])
/** Small words that do not count toward the four, and never end a title. */
const SMALL = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'and', 'or', 'my', 'our', 'this', 'that', 'it', 'its', 'is', 'at', 'by', 'from', 'into'])
/** Words after which the rest of a request says where or how, not what. */
const BOUNDARY = new Set(['to', 'in', 'on', 'for', 'with', 'and', 'or', 'from', 'into', 'at', 'by', 'so', 'but', 'then', 'because', 'when', 'if', 'which', 'that', 'using', 'via'])
const MAX_WORDS = 4

/**
 * Two to four words a prompt is about: its first sentence, the request's
 * opening ("can you please", "I want you to") dropped, a path cut to its last
 * part, and stopped after four words that carry meaning ("a", "the" ride
 * along). No model, no network: string work on text already held.
 */
export function promptTitle(prompt: string | undefined): string {
  const line = (prompt ?? '').split('\n').map((l) => l.trim()).find((l) => l) ?? ''
  const sentence = line.replace(/^["“”'`]+|["“”'`]+$/g, '').split(/(?<=[.!?])\s|[;:]\s|\s[—–-]\s/)[0] ?? ''
  let words = sentence.split(/\s+/).filter(Boolean).map(word)
  while (words.length > 1 && OPENERS.has(bare(words[0]!))) words = words.slice(1)
  const out: string[] = []
  let counted = 0
  for (const w of words) {
    // Two words that carry meaning and then "to", "in", "and": the rest is
    // where or how, not what ("fix the login bug | in auth.go").
    if (counted >= 2 && BOUNDARY.has(bare(w))) break
    out.push(w)
    if (!SMALL.has(bare(w)) && ++counted >= MAX_WORDS) break
  }
  while (out.length > 1 && SMALL.has(bare(out[out.length - 1]!))) out.pop()
  const text = out.join(' ').replace(/[,.!?;:…]+$/, '')
  return text ? text[0]!.toUpperCase() + text.slice(1) : ''
}

function bare(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
}

/** A path or URL as its last part; any other word as it is. */
function word(w: string): string {
  if (/^(~|\.{0,2}\/|[a-z]+:\/\/)/i.test(w) && w.includes('/')) {
    const parts = w.replace(/[/,.;:!?]+$/, '').split('/').filter(Boolean)
    return parts[parts.length - 1] ?? w
  }
  return w
}
