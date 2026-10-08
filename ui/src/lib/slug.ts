/** A worktree name from a task's words: "Fix the login bug" → "fix-the-login-bug". */
export function worktreeSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-').slice(0, 40).replace(/-+$/, '')
}

/** What the daemon takes as a worktree name: one path segment, no separators. */
export const WORKTREE_NAME = /^[\w.-]+$/

/** A worktree's name when none was typed: the first message's words, else the
 *  time, so leaving the field empty never stops a start. */
export function defaultWorktreeName(prompt: string, now = new Date()): string {
  const slug = worktreeSlug(prompt)
  if (slug) return slug
  const p = (n: number) => String(n).padStart(2, '0')
  return `agent-${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
}
