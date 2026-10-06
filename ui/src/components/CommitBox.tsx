/**
 * Committing and syncing a worktree, shared by the app's Changes view and
 * the phone's Changes tab: a message box with Commit and Commit & Push, and
 * Push, Pull and Fetch. Every failure is shown with git's or the hook's own
 * output; nothing is forced.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { api } from '@/lib/api'
import { changesApi, changedCount, failureOf, messageFromSummary, type ChangeFailure, type Changes, type WorktreeRef } from '@/lib/changes'

const DRAFT_PREFIX = 'caprock.changes.message.'

function draftKey(ref: WorktreeRef): string {
  return `${DRAFT_PREFIX}${ref.projectId}:${ref.worktree}`
}

function loadDraft(ref: WorktreeRef): string {
  try { return localStorage.getItem(draftKey(ref)) ?? '' } catch { return '' }
}

function saveDraft(ref: WorktreeRef, text: string): void {
  try {
    if (text) localStorage.setItem(draftKey(ref), text)
    else localStorage.removeItem(draftKey(ref))
  } catch { /* not kept */ }
}

/** What the last action said: done, or failed with git's words. */
export type Outcome = { ok: true; text: string; output?: string } | { ok: false; failure: ChangeFailure }

export function OutcomeLine({ outcome, onDismiss, compact }: { outcome: Outcome; onDismiss?: () => void; compact?: boolean }) {
  const output = outcome.ok ? outcome.output : outcome.failure.output
  return (
    <div
      role={outcome.ok ? 'status' : 'alert'}
      className={`grid gap-1 rounded-[8px] border px-2.5 py-2 text-[12px] leading-snug ${outcome.ok ? 'border-ok/35 bg-ok/[0.06] text-fg' : 'border-danger/40 bg-danger/[0.06] text-fg'}`}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {outcome.ok ? outcome.text : outcome.failure.message}
        </span>
        {onDismiss && (
          <button type="button" onClick={onDismiss} aria-label="Dismiss" className={`shrink-0 text-fg-faint hover:text-fg ${compact ? 'min-h-11 min-w-11' : ''}`}>×</button>
        )}
      </div>
      {output && (
        <details open={!outcome.ok}>
          <summary className="cursor-pointer text-[11px] text-fg-muted">{outcome.ok ? 'Output' : outcome.failure.kind === 'hook' ? 'What the hook said' : 'What git said'}</summary>
          <pre className="app-scroll mono mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-[6px] bg-[var(--app-row-hover,rgba(127,127,127,0.08))] p-2 text-[11px] text-fg-muted [overflow-wrap:anywhere]">{output}</pre>
        </details>
      )}
    </div>
  )
}

export interface CommitBoxHandle {
  focus: () => void
}

export interface CommitBoxProps {
  target: WorktreeRef
  changes?: Changes
  onChanges: (c: Changes) => void
  /** The worktree's latest agent session: its last words can draft the message. */
  sessionId?: string
  /** Phone: 44 px targets, stacked buttons. */
  compact?: boolean
  /** Shown above the buttons, e.g. a hint. */
  footer?: ReactNode
}

/**
 * The message box and the two commit buttons. With something staged, Commit
 * commits that; with nothing staged, it commits every change (the button
 * says so). ⌘↵ commits, ⇧⌘↵ commits and pushes.
 */
export const CommitBox = forwardRef<CommitBoxHandle, CommitBoxProps>(function CommitBox({ target, changes, onChanges, sessionId, compact }, handle) {
  const [message, setMessage] = useState(() => loadDraft(target))
  const [busy, setBusy] = useState<'' | 'commit' | 'push' | 'summary'>('')
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(handle, () => ({ focus: () => box.current?.focus() }), [])

  const key = draftKey(target)
  useEffect(() => { setMessage(loadDraft(target)); setOutcome(null) }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { saveDraft(target, message) }, [message]) // eslint-disable-line react-hooks/exhaustive-deps

  const staged = changes?.staged.length ?? 0
  const total = changedCount(changes)
  const conflicted = (changes?.conflicted.length ?? 0) > 0
  const all = staged === 0
  const canCommit = !!changes && total > 0 && !conflicted && message.trim() !== '' && !busy
  const label = all ? `Commit all ${total}` : `Commit ${staged} staged`

  const summarize = async () => {
    if (!sessionId) return
    setBusy('summary')
    try {
      const notes = await api.notes(sessionId, 12)
      const note = notes.find((n) => !n.fragment) ?? notes[0]
      if (!note) setOutcome({ ok: false, failure: { message: 'The agent has not said anything yet in this worktree.' } })
      else setMessage(messageFromSummary(note.text))
    } catch (e) {
      setOutcome({ ok: false, failure: failureOf(e) })
    } finally {
      setBusy('')
    }
  }

  const commit = async (andPush: boolean) => {
    if (!canCommit) return
    setBusy(andPush ? 'push' : 'commit')
    setOutcome(null)
    try {
      const r = await changesApi.commit(target, message, all)
      onChanges(r.changes)
      setMessage('')
      let text = `Committed ${r.commit.short} “${r.commit.subject}”.`
      let output = r.commit.output
      if (andPush) {
        try {
          const p = await changesApi.push(target)
          onChanges(p.changes)
          text += ` Pushed to ${p.result.remote}/${p.result.branch}${p.result.upstream_set ? ' (now tracked)' : ''}.`
          output = [output, p.result.output].filter(Boolean).join('\n')
        } catch (e) {
          const f = failureOf(e)
          setOutcome({ ok: false, failure: { ...f, message: `Committed ${r.commit.short}, but the push failed: ${f.message}` } })
          return
        }
      }
      setOutcome({ ok: true, text, output })
    } catch (e) {
      setOutcome({ ok: false, failure: failureOf(e) })
    } finally {
      setBusy('')
    }
  }

  const h = compact ? 'min-h-11' : 'h-[30px]'
  return (
    <div className="grid gap-2">
      <textarea
        ref={box}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void commit(e.shiftKey)
          } else if (e.key === 'Escape') {
            e.currentTarget.blur()
            e.stopPropagation()
          }
        }}
        placeholder={total === 0 ? 'Nothing to commit' : 'Commit message'}
        aria-label="Commit message"
        rows={compact ? 3 : 4}
        spellCheck
        className={`w-full resize-y rounded-[8px] border border-[var(--app-hairline-strong,var(--color-border))] bg-bg px-2.5 py-2 text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none ${compact ? 'text-[16px]' : 'text-[12.5px]'}`}
      />
      {sessionId && total > 0 && (
        <button
          type="button"
          onClick={() => void summarize()}
          disabled={!!busy}
          className={`justify-self-start text-[11.5px] text-fg-muted underline-offset-2 hover:text-fg hover:underline disabled:opacity-50 ${compact ? 'min-h-11' : ''}`}
        >
          {busy === 'summary' ? 'Reading what the agent said…' : message.trim() ? 'Replace with the agent’s summary' : 'Use the agent’s summary'}
        </button>
      )}
      {conflicted && <p className="text-[11.5px] text-danger">Resolve the conflicts in an editor before committing.</p>}
      <div className={`flex gap-2 ${compact ? 'flex-col' : ''}`}>
        <button
          type="button"
          disabled={!canCommit}
          onClick={() => void commit(false)}
          title="⌘↵"
          className={`${h} flex-1 rounded-[7px] bg-accent px-3 text-[12.5px] font-medium text-bg hover:brightness-110 disabled:opacity-40`}
        >
          {busy === 'commit' ? 'Committing…' : label}
        </button>
        <button
          type="button"
          disabled={!canCommit || !changes?.remote || !!changes?.detached}
          onClick={() => void commit(true)}
          title={changes?.remote ? '⇧⌘↵' : 'This repository has no remote'}
          className={`${h} flex-1 rounded-[7px] border border-[var(--app-hairline-strong,var(--color-border))] px-3 text-[12.5px] text-fg hover:bg-[var(--app-row-hover,transparent)] disabled:opacity-40`}
        >
          {busy === 'push' ? 'Committing and pushing…' : 'Commit & Push'}
        </button>
      </div>
      {outcome && <OutcomeLine outcome={outcome} onDismiss={() => setOutcome(null)} compact={compact} />}
    </div>
  )
})

/** What Push says it will do: publish a new branch, or push N commits. */
function pushLabel(c: Changes): string {
  if (!c.published) return 'Publish branch'
  return c.ahead > 0 ? `Push ${c.ahead}` : 'Push'
}

/** Push, Pull and Fetch for the branch, with where it stands against its upstream. */
export function RemoteActions({ target, changes, onChanges, compact, onOutcome }: {
  target: WorktreeRef
  changes?: Changes
  onChanges: (c: Changes) => void
  compact?: boolean
  /** Where the result is shown; inline under the buttons when absent. */
  onOutcome?: (o: Outcome | null) => void
}) {
  const [busy, setBusy] = useState<'' | 'push' | 'pull' | 'fetch'>('')
  const [own, setOwn] = useState<Outcome | null>(null)
  const show = onOutcome ?? setOwn
  const run = async (what: 'push' | 'pull' | 'fetch') => {
    setBusy(what)
    show(null)
    try {
      const r = await changesApi[what](target)
      onChanges(r.changes)
      const where = r.result.remote ? `${r.result.remote}${r.result.branch ? `/${r.result.branch}` : ''}` : 'the remote'
      const text = what === 'push'
        ? `Pushed to ${where}${r.result.upstream_set ? '; the branch now tracks it' : ''}.`
        : what === 'pull'
          ? `Up to date with ${r.changes.upstream ?? where}.`
          : `Fetched ${r.changes.remote ?? where}: ${r.changes.ahead} ahead, ${r.changes.behind} behind.`
      show({ ok: true, text, output: r.result.output })
    } catch (e) {
      show({ ok: false, failure: failureOf(e) })
    } finally {
      setBusy('')
    }
  }
  const c = changes
  const h = compact ? 'min-h-11 px-3' : 'h-[26px] px-2.5'
  const btn = `${h} rounded-[7px] border border-[var(--app-hairline-strong,var(--color-border))] text-[12px] text-fg hover:bg-[var(--app-row-hover,transparent)] disabled:opacity-40`
  const noRemote = !c?.remote
  return (
    <div className="grid gap-2">
      <div className={`flex flex-wrap items-center gap-1.5 ${compact ? '' : 'justify-end'}`}>
        <button type="button" className={btn} disabled={!!busy || noRemote} onClick={() => void run('fetch')} title={noRemote ? 'No remote' : `Fetch ${c?.remote}`}>
          {busy === 'fetch' ? 'Fetching…' : 'Fetch'}
        </button>
        <button type="button" className={btn} disabled={!!busy || !c?.upstream || !!c?.detached} onClick={() => void run('pull')} title={c?.upstream ? `Fast-forward from ${c.upstream}` : 'This branch tracks no remote branch'}>
          {busy === 'pull' ? 'Pulling…' : c && c.behind > 0 ? `Pull ${c.behind}` : 'Pull'}
        </button>
        <button
          type="button"
          className={`${btn} ${c && (c.ahead > 0 || !c.published) && !noRemote ? 'border-accent/60 text-accent' : ''}`}
          disabled={!!busy || noRemote || !c || !!c.detached || !c.head || (c.published && c.ahead === 0)}
          onClick={() => void run('push')}
          title={noRemote ? 'No remote' : c && !c.published ? `Push ${c.branch} to ${c.remote}/${c.branch} and track it` : 'Never forced'}
        >
          {busy === 'push' ? 'Pushing…' : c ? pushLabel(c) : 'Push'}
        </button>
      </div>
      {!onOutcome && own && <OutcomeLine outcome={own} onDismiss={() => setOwn(null)} compact={compact} />}
    </div>
  )
}
