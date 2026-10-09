/**
 * Turning a few words into a filed issue.
 *
 * Nothing is sent from here. The dashboard composes a GitHub issue URL and
 * opens it; the user sees the whole thing, edits it if they want, and presses
 * Submit themselves. That keeps the local-first promise intact — a promise
 * people install this product *because of* — while still getting us a report
 * with the context already in it.
 *
 * There is deliberately no rewriting of what the user typed. Making prose out
 * of "button is crooked" needs a model, and Caprock has no API calls; adding
 * one would mean either asking for a key or posting their words to a server,
 * which is the thing we are avoiding. Structure does the same job: a chosen
 * kind, their words verbatim, and a diagnostics block underneath.
 *
 * Screenshots cannot travel in a URL, and uploading them anywhere would be
 * the thing we are avoiding, so they go the way a person would carry them:
 * on the clipboard, one at a time, into GitHub's own comment box
 * (`lib/attachments.ts`).
 */
import type { Status } from './api'
import { isWorkspaceHash } from './appmode'
import { parseHash, type Route } from './router'

export type FeedbackKind = 'bug' | 'idea' | 'question'

/**
 * Three, one word each, as a segmented control. Each maps to a label that
 * exists on dspv/caprock (`gh label list`): a label that does not exist is
 * dropped by GitHub without a word, so the mapping is pinned by a test.
 * "Unclear" and "other" were folded into Question: both already went out
 * with the `question` label, and four near-identical buttons made people
 * stop to choose.
 */
export const KINDS: { id: FeedbackKind; label: string; title: string; hint: string; gh: string }[] = [
  { id: 'bug', label: 'Bug', title: 'e.g. Cost chart is empty after a restart', hint: 'What did you do, what did you expect, what happened instead?', gh: 'bug' },
  { id: 'idea', label: 'Idea', title: 'e.g. Show cost per branch', hint: 'What would you like, and what would it help you do?', gh: 'enhancement' },
  { id: 'question', label: 'Question', title: 'e.g. What does "session total" include?', hint: 'What were you trying to find out?', gh: 'question' },
]

/** Where issues go. */
const REPO = 'dspv/caprock'

/**
 * context is exactly what gets attached, and it is a short list on purpose.
 *
 * Version and platform make a report reproducible. Scale (events, sessions)
 * separates "it broke immediately" from "it broke on a large history". Hooks
 * and orchestration decide which code path was even running.
 *
 * Deliberately absent: project names, file paths, and cost. Those are the
 * user's repositories and the user's money, and neither helps us fix a
 * crooked button. The data directory path is left out for the same reason —
 * it contains their username.
 */
export function context(status: Status | undefined, screen: string): string[] {
  if (!status) return [`Screen: ${screen}`]
  const hooks = status.hooks
  const hooksState = !hooks
    ? 'unknown'
    : (hooks.missing?.length ?? 0) > 0
      ? 'partly installed'
      : hooks.shim_exists
        ? 'installed'
        : 'not installed'
  return [
    `Caprock ${status.version}${status.platform ? ` (${status.platform})` : ''}`,
    `Screen: ${screen}`,
    `${status.events.toLocaleString('en-US')} events${status.owned_active ? ` · ${status.owned_active} owned session(s) running` : ''}`,
    `Hooks: ${hooksState} · Orchestration: ${status.orchestration ? 'on' : 'off'}`,
  ]
}

/**
 * The issue title is the user's own title, trimmed to one line. GitHub caps a
 * title at 256 characters; past that the form refuses to submit, so a pasted
 * paragraph is cut here with an ellipsis rather than there with an error.
 */
export function title(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  return line.length > maxTitle ? `${line.slice(0, maxTitle - 1)}…` : line
}

const maxTitle = 200

export interface Report {
  kind: FeedbackKind
  title: string
  /** The description, verbatim. May be empty: the title can be the whole report. */
  text: string
  /** The diagnostics lines, or null when the user left them out. */
  ctx: string[] | null
  /** Screenshots attached in the dialog: they travel by clipboard, not in the URL. */
  shots: number
  /** ⌘V or Ctrl+V, for the line that says where the screenshots go. */
  pasteKey?: string
}

/**
 * body is the issue text: their words first, diagnostics second (when kept),
 * and a last line asking for the screenshots, which a URL cannot carry. The
 * line is last because pasting under it is the next thing the user does.
 */
export function body(r: Report): string {
  const heading = r.kind === 'bug' ? 'What happened' : r.kind === 'idea' ? 'The idea' : 'The question'
  const trimmed = r.text.trim()
  const clipped =
    trimmed.length > maxText
      ? `${trimmed.slice(0, maxText)}\n\n_[…truncated — the rest did not fit in the link; paste it below]_`
      : trimmed
  const out = [`### ${heading}`, '', clipped || '_(see the title)_', '']
  if (r.ctx && r.ctx.length > 0) out.push('### Diagnostics', '', ...r.ctx.map((c) => `- ${c}`), '')
  out.push(
    '<sub>Filed from the Caprock dashboard. Nothing was sent automatically — this issue was opened in your browser for you to review.</sub>',
  )
  if (r.shots > 0) {
    out.push('', `**Screenshots: ${r.shots} — paste ${r.shots === 1 ? 'it' : 'them'} here (${r.pasteKey ?? '⌘V'}).**`, '')
  }
  return out.join('\n')
}

/** The GitHub "new issue" URL, prefilled. */
export function issueURL(r: Report): string {
  const k = KINDS.find((x) => x.id === r.kind) ?? KINDS[0]!
  const q = new URLSearchParams({
    title: title(r.title),
    body: body(r),
    labels: k.gh,
  })
  return `https://github.com/${REPO}/issues/new?${q.toString()}`
}

/**
 * maxText bounds what travels in the URL. GitHub silently truncates a prefilled
 * issue past roughly 8k characters, and losing the end of someone's report
 * without telling them is worse than asking them to trim it — measured, a
 * 20,000-character report produced a 20,386-character URL.
 */
const maxText = 6000

/** A title worth filing: a few characters, not whitespace. */
export function isSendable(titleText: string): boolean {
  return titleText.trim().length >= 3
}

/** A human name for a dashboard screen, for a report's title and context. */
export function screenName(r: Route): string {
  switch (r.name) {
    case 'now': return 'Now'
    case 'session': return 'Session detail'
    case 'cost': return 'Cost'
    case 'history': return 'Lifetime'
    case 'week': return 'Week'
    case 'tasks': return 'Tasks'
    case 'graph': return 'Graph'
    case 'notes': return 'Memory'
    case 'settings': return 'Settings'
    case 'start': return 'Start work'
  }
}

/** The screen in front, from the location hash: the app's tabs, or a dashboard screen. */
export function currentScreen(hash: string, app: boolean): string {
  return app && isWorkspaceHash(hash) ? 'App tabs' : screenName(parseHash(hash))
}
