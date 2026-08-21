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
 * kind, their words verbatim, and a context block underneath.
 */
import type { Status } from './api'

export type FeedbackKind = 'bug' | 'idea' | 'question'

export const KINDS: { id: FeedbackKind; label: string; hint: string; gh: string }[] = [
  { id: 'bug', label: 'Something is broken', hint: 'What did you see?', gh: 'bug' },
  { id: 'idea', label: 'Something is missing', hint: 'What would you want?', gh: 'enhancement' },
  { id: 'question', label: 'Something is unclear', hint: 'What did not make sense?', gh: 'question' },
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

/** A title someone can scan in a list: kind, screen, then their own words. */
export function title(kind: FeedbackKind, screen: string, body: string): string {
  const first = body.trim().split('\n')[0]?.trim() ?? ''
  const short = first.length > 60 ? `${first.slice(0, 57)}…` : first
  return `[${kind}] ${screen}: ${short}`
}

/**
 * body is the issue text: their words first, context second, and a line saying
 * where it came from so a maintainer knows the context was filled in for them
 * rather than typed by hand.
 */
export function body(kind: FeedbackKind, text: string, ctx: string[]): string {
  const heading =
    kind === 'bug' ? 'What happened' : kind === 'idea' ? 'What is missing' : 'What is unclear'
  const trimmed = text.trim()
  const clipped =
    trimmed.length > maxText
      ? `${trimmed.slice(0, maxText)}\n\n_[…truncated — the rest did not fit in the link; paste it below]_`
      : trimmed
  return [
    `### ${heading}`,
    '',
    clipped,
    '',
    '### Context',
    '',
    ...ctx.map((c) => `- ${c}`),
    '',
    '<sub>Filed from the Caprock dashboard. Nothing was sent automatically — this issue was opened in your browser for you to review.</sub>',
  ].join('\n')
}

/** The GitHub "new issue" URL, prefilled. */
export function issueURL(kind: FeedbackKind, screen: string, text: string, ctx: string[]): string {
  const k = KINDS.find((x) => x.id === kind) ?? KINDS[0]!
  const q = new URLSearchParams({
    title: title(kind, screen, text),
    body: body(kind, text, ctx),
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
export const maxText = 6000

/** Enough words to be worth filing. */
export function isSendable(text: string): boolean {
  return text.trim().length >= 8
}
