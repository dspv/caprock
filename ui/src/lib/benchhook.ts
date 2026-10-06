/**
 * The benchmark's handle on a terminal (WP-16, bench/README.md).
 *
 * bench/ times a keystroke to the frame that shows its echo, and that needs
 * xterm's own write callback. Its page hook sets `window.__caprockBench`
 * before the page's scripts run; only then does a terminal register itself
 * here, by session id. In every other page this is a no-op.
 *
 * Two terminals can show one session for a moment (a tab and the session
 * screen during a route change), so the newest live one is the one in `terms`.
 */
import type { Terminal as Xterm } from '@xterm/xterm'

interface BenchHook {
  terms: Map<string, Xterm>
  stacks?: Map<string, Xterm[]>
}

/** Registers `term` for the bench when its hook is present; returns the unregister. */
export function registerBenchTerminal(sessionId: string, term: Xterm): () => void {
  const hook = (window as { __caprockBench?: BenchHook }).__caprockBench
  if (!hook?.terms) return () => {}
  const stacks = (hook.stacks ??= new Map())
  const stack = stacks.get(sessionId) ?? []
  stack.push(term)
  stacks.set(sessionId, stack)
  hook.terms.set(sessionId, term)
  return () => {
    const i = stack.indexOf(term)
    if (i >= 0) stack.splice(i, 1)
    const top = stack[stack.length - 1]
    if (top) hook.terms.set(sessionId, top)
    else {
      hook.terms.delete(sessionId)
      stacks.delete(sessionId)
    }
  }
}
